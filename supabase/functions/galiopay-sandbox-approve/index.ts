import { createAdminClient, corsHeaders } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    const { order_id } = await req.json();
    if (!order_id) {
      return new Response(JSON.stringify({ error: "order_id is required" }), {
        status: 400,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    const supabase = createAdminClient();
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("id, provider_preference_id, metadata, provider")
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
      .eq("environment", "sandbox")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (configError || !config) {
      return new Response(JSON.stringify({ error: "No active sandbox Galiopay config found" }), {
        status: 400,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    const clientId = config.extra_config?.client_id || config.public_key;
    const apiKey = config.extra_config?.api_key || config.access_token;
    const proof = order.metadata?.galiopay?.proofToken;
    const paymentLinkId = order.provider_preference_id;

    if (!clientId || !apiKey || !proof || !paymentLinkId) {
      return new Response(JSON.stringify({ error: "Missing sandbox data to approve payment" }), {
        status: 400,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    const response = await fetch(`https://pay.galio.app/api/payment-links/${paymentLinkId}/sandbox-action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        proof,
        action: "approve",
      }),
    });

    const result = await response.json().catch(() => ({}));
    return new Response(JSON.stringify(result), {
      status: response.status,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unexpected error" }), {
      status: 500,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }
});
