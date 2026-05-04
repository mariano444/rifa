import { createAdminClient, corsHeaders, json } from "../_shared/supabase.ts";

function normalizeBaseUrl(url: string) {
  return url.replace(/\/$/, "");
}

function buildReturnUrl(baseUrl: string, params: Record<string, string>) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function parsePaymentLinkId(url: string) {
  const match = url.match(/\/payment\/([^?]+)/i);
  return match?.[1] ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    const { order_id, landing_url, landing_origin } = await req.json();
    if (!order_id) {
      return new Response(JSON.stringify({ error: "order_id is required" }), {
        status: 400,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    const supabase = createAdminClient();
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(`
        id,
        external_reference,
        provider,
        amount_ars,
        status,
        campaign_id,
        participant_id,
        package_id,
        participants!inner(full_name, phone, city),
        packages!inner(name, entries_qty, bonus_entries, price_ars),
        campaigns!inner(slug, title),
        metadata
      `)
      .eq("id", order_id)
      .single();

    if (orderError || !order) {
      return new Response(JSON.stringify({ error: "Order not found" }), {
        status: 404,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    const { data: config, error: configError } = await supabase
      .from("payment_provider_configs")
      .select("*")
      .eq("provider", "galiopay")
      .eq("is_active", true)
      .order("environment", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (configError || !config) {
      return new Response(JSON.stringify({ error: "No active Galiopay config found" }), {
        status: 400,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    const clientId = config.extra_config?.client_id || config.public_key;
    const apiKey = config.extra_config?.api_key || config.access_token;
    if (!clientId || !apiKey) {
      return new Response(JSON.stringify({ error: "Missing Galiopay Client ID or API Key" }), {
        status: 400,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    if (!supabaseUrl) {
      throw new Error("Missing SUPABASE_URL");
    }

    const configuredLandingUrl = String(config.extra_config?.landing_url || "").trim();
    const configuredLandingBaseUrl = String(config.extra_config?.landing_base_url || "").trim();
    const requestLandingUrl = String(landing_url || "").trim();
    const requestLandingOrigin = String(landing_origin || req.headers.get("origin") || "").trim();
    const baseLandingUrl =
      requestLandingUrl ||
      configuredLandingUrl ||
      (configuredLandingBaseUrl
        ? `${normalizeBaseUrl(configuredLandingBaseUrl)}/sorteo-moto-tv-dinero.html`
        : requestLandingOrigin
          ? `${normalizeBaseUrl(requestLandingOrigin)}/sorteo-moto-tv-dinero.html`
          : "");

    if (!baseLandingUrl) {
      return new Response(JSON.stringify({ error: "Missing landing URL for checkout return" }), {
        status: 400,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    const successUrl =
      config.extra_config?.success_url ||
      buildReturnUrl(baseLandingUrl, {
        payment: "success",
        order_ref: order.external_reference,
      });
    const failureUrl =
      config.extra_config?.failure_url ||
      buildReturnUrl(baseLandingUrl, {
        payment: "failure",
        order_ref: order.external_reference,
      });
    const notificationUrl =
      config.extra_config?.webhook_url ||
      `${normalizeBaseUrl(supabaseUrl)}/functions/v1/galiopay-webhook`;

    const totalEntries = Number(order.packages.entries_qty || 0) + Number(order.packages.bonus_entries || 0);
    const checkoutText =
      config.extra_config?.checkout_text ||
      `${order.campaigns.title} - ${totalEntries} chances`;
    const checkoutImageUrl = String(config.extra_config?.checkout_image_url || "").trim();
    const item = {
      title: checkoutText,
      quantity: 1,
      unitPrice: Number(order.packages.price_ars || order.amount_ars || 0),
      currencyId: "ARS",
      ...(checkoutImageUrl ? { imageUrl: checkoutImageUrl } : {}),
    };

    const payload = {
      items: [item],
      referenceId: order.external_reference,
      notificationUrl,
      sandbox: config.environment === "sandbox",
      backUrl: {
        success: successUrl,
        failure: failureUrl,
      },
    };

    const response = await fetch("https://pay.galio.app/api/payment-links", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "x-client-id": clientId,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      return new Response(JSON.stringify({ error: result.error || "Failed to create Galiopay payment link", details: result }), {
        status: response.status,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    const paymentLinkId = parsePaymentLinkId(result.url);

    const { error: updateError } = await supabase
      .from("orders")
      .update({
        provider: "galiopay",
        provider_preference_id: paymentLinkId,
        payment_url: result.url,
        metadata: {
          ...(order.metadata || {}),
          galiopay: {
            proofToken: result.proofToken,
            paymentLinkId,
            notificationUrl,
            successUrl,
            failureUrl,
            landingUrl: baseLandingUrl,
          },
        },
      })
      .eq("id", order.id);

    if (updateError) {
      return new Response(JSON.stringify({ error: updateError.message }), {
        status: 500,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      checkout_url: result.url,
      proof_token: result.proofToken,
      reference_id: result.referenceId,
      sandbox: result.sandbox,
    }), {
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unexpected error" }), {
      status: 500,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }
});
