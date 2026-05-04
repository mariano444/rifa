# Implementación del sistema

## Qué te dejé

- [supabase-full-system.sql](C:\Users\manza\Downloads\sort\supabase-full-system.sql): crea toda la base en Supabase.
- [admin-panel.html](C:\Users\manza\Downloads\sort\admin-panel.html): panel administrativo base conectado a Supabase.
- [sorteo-moto-tv-dinero.html](C:\Users\manza\Downloads\sort\sorteo-moto-tv-dinero.html): landing conectada al proyecto Supabase `asokopamdmuvuupywjzt`.

## Qué resuelve el SQL

- Campañas de sorteos.
- Paquetes de compra con una o más chances.
- Participantes y órdenes.
- Enlace único de referido para cada comprador.
- Recompensa automática de 2 chances cuando compra alguien desde ese enlace.
- El enlace único se habilita al aprobar una compra de 3 o más chances.
- Configuración de Mercado Pago y Galiopay desde el panel.
- Storage público para fotos y piezas visuales.
- RLS para separar acceso público, usuario y administrador.

## Cómo usarlo en Supabase

1. Abrí `SQL Editor` en tu proyecto Supabase.
2. Pegá el contenido de [supabase-full-system.sql](C:\Users\manza\Downloads\sort\supabase-full-system.sql).
3. Ejecutalo completo.
4. Creá tu usuario administrador en `Authentication > Users`.
5. Luego insertá su UUID en `admin_users`:

```sql
insert into public.admin_users (user_id, role)
values ('UUID_DEL_USUARIO', 'super_admin')
on conflict (user_id) do update
set role = excluded.role,
    is_active = true;
```

## Cómo usar el panel admin

1. Abrí [admin-panel.html](C:\Users\manza\Downloads\sort\admin-panel.html).
2. Pegá tu `Supabase URL` y tu `anon key`.
3. Iniciá sesión con el usuario admin.
4. Creá una campaña.
5. Cargá paquetes.
6. Subí fotos al bucket `campaign-media`.
7. Guardá las credenciales de `mercado_pago` y `galiopay`.
8. Cuando entre una orden nueva desde la landing, marcala como pagada desde el panel.
9. Si esa compra aprobada tiene 3 o más chances, el sistema genera automáticamente el enlace único del participante.

## Flujo de compra y referido

1. Un comprador paga una orden.
2. Cuando la orden pasa a `paid`, el trigger:
   suma sus chances,
   genera su link único si ya tiene 3 o más chances,
   y si vino por referido premia al dueño del link con 2 chances.
3. El código único queda en `referral_links.code`.
4. Podés armar el enlace compartible así:

```text
https://tu-dominio.com/?ref=CODIGO_UNICO
```

## Lo que falta para producción

El SQL y el panel te dejan la base lista, pero para completar el circuito real de cobro conviene agregar 3 Edge Functions en Supabase:

- `create-payment-link`: crea el checkout en Mercado Pago o Galiopay.
- `payment-webhook`: recibe confirmaciones del proveedor y cambia la orden a `paid`.
- `confirm-return`: confirma el pago al volver desde el checkout.

## Recomendación importante

Las credenciales hoy quedan guardadas en `payment_provider_configs` con acceso solo admin por RLS. Eso funciona, pero en producción te conviene mover `access_token` y `webhook_secret` a Supabase Vault o a secretos de Edge Functions.
