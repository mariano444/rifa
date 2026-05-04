# Galiopay setup

## Qué quedó implementado

- [supabase/functions/galiopay-create-payment/index.ts](C:\Users\manza\Downloads\sort\supabase\functions\galiopay-create-payment\index.ts)
- [supabase/functions/galiopay-webhook/index.ts](C:\Users\manza\Downloads\sort\supabase\functions\galiopay-webhook\index.ts)
- [supabase/functions/galiopay-sandbox-approve/index.ts](C:\Users\manza\Downloads\sort\supabase\functions\galiopay-sandbox-approve\index.ts)

La landing crea la orden, llama a `galiopay-create-payment`, obtiene la URL del payment link y redirige al checkout.

Cuando Galiopay envía el webhook a `galiopay-webhook` y el `status` llega como `approved`, la orden se marca como `paid`, se guarda la transacción y los triggers suman las chances y activan el enlace de referido.

## Cómo configurar desde el panel

En [admin-privado.html](C:\Users\manza\Downloads\sort\admin-privado.html):

- `Proveedor`: `galiopay`
- `Modo`: `sandbox` o `production`
- `Client ID`
- `API Key`
- `Texto del checkout`
- `URL de Webhook`

Recomendación:

- En `sandbox`, podés usar como webhook:

```text
https://asokopamdmuvuupywjzt.supabase.co/functions/v1/galiopay-webhook
```

## Deploy

Tenés que desplegar las funciones en tu proyecto Supabase:

```powershell
npx supabase functions deploy galiopay-create-payment --no-verify-jwt --project-ref asokopamdmuvuupywjzt
npx supabase functions deploy galiopay-webhook --no-verify-jwt --project-ref asokopamdmuvuupywjzt
npx supabase functions deploy galiopay-sandbox-approve --no-verify-jwt --project-ref asokopamdmuvuupywjzt
```

Y antes de probar la landing o el panel, volvÃ© a ejecutar [supabase-full-system.sql](C:\Users\manza\Downloads\sort\supabase-full-system.sql) para crear `get_public_order_status(...)`, recargar el schema RPC y dejar disponibles los wrappers de `admin_get_provider_config(...)` y `admin_upsert_provider_config(...)`.

Y asegurarte de tener configurados estos secretos:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

## Fuentes

GalioPay Payment Links API:
[Payment Links API](https://pay.galio.app/docs/api/paymentlink)
