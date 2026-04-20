# Agente personal (MVP)

Monorepo con **Next.js**, **Supabase**, **LangGraph** y **OpenRouter**. Incluye chat web, onboarding, ajustes, bot de **Telegram** (opcional) e integración con **GitHub** y **Google Calendar**.

## Requisitos previos

- **Node.js** 20 o superior (recomendado LTS).
- **npm** 10+ (incluido con Node.js 20+).
- Cuenta en **[Supabase](https://supabase.com)** (gratis).
- Cuenta en **[OpenRouter](https://openrouter.ai)** para la API del modelo (clave de API).
- *(Opcional)* Bot de Telegram creado con [@BotFather](https://t.me/BotFather) y una URL **HTTPS** pública para el webhook (en local suele usarse **ngrok** o similar).
- *(Opcional)* **GitHub OAuth App** para integración con repositorios e issues.
- *(Opcional)* **Google Cloud project** con la Calendar API habilitada y un OAuth 2.0 Client ID para integración con Google Calendar.

---

## Paso 1 — Clonar e instalar dependencias

```bash
cd agents
npm install
```

---

## Paso 2 — Crear proyecto en Supabase

1. Entra en el [dashboard de Supabase](https://supabase.com/dashboard) y crea un **nuevo proyecto**.
2. Espera a que termine el aprovisionamiento.
3. En **Project Settings → API** anota:
   - **Project URL** → será `NEXT_PUBLIC_SUPABASE_URL`
   - **`anon` public** → será `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **`service_role` secret** → será `SUPABASE_SERVICE_ROLE_KEY` (no la expongas al cliente ni la subas a repositorios públicos).

---

## Paso 3 — Aplicar el esquema SQL (tablas + RLS)

1. En Supabase, abre **SQL Editor**.
2. Abre el archivo del repo:

   `packages/db/supabase/migrations/00001_initial_schema.sql`

3. Copia **todo** el contenido y pégalo en el editor.
4. Ejecuta el script (**Run**).

Si algo falla (por ejemplo, el trigger `on_auth_user_created` en un proyecto ya modificado), revisa el mensaje de error; en la mayoría de proyectos nuevos el script aplica de una vez.

---

## Paso 4 — Configurar autenticación (email)

1. En Supabase: **Authentication → Providers** → habilita **Email** (por defecto suele estar activo).
2. **Authentication → URL configuration**:
   - **Site URL**: para desarrollo local usa `http://localhost:3000`
   - **Redirect URLs**: añade al menos:
     - `http://localhost:3000/auth/callback`
     - `http://localhost:3000/**` (o la variante que permita tu versión del dashboard para desarrollo)

Así el flujo de login/signup y el intercambio de código en `/auth/callback` funcionan en local.

---

## Paso 5 — Variables de entorno

Next.js carga `.env*` desde el directorio de la app **`apps/web`**, no desde la raíz del monorepo.

1. Copia el ejemplo:

   ```bash
   cp .env.example apps/web/.env.local
   ```

   *(Si ya tienes `.env.local` en la raíz, mueve o copia ese archivo a `apps/web/.env.local`.)*

2. Edita `apps/web/.env.local` y completa:

   | Variable | Descripción |
   |----------|-------------|
   | `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave `anon` |
   | `SUPABASE_SERVICE_ROLE_KEY` | Clave `service_role` (solo servidor; la usa la API del agente y Telegram contra Postgres) |
   | `OPENROUTER_API_KEY` | Clave de OpenRouter |
   | `TELEGRAM_BOT_TOKEN` | *(Opcional)* Token del bot |
   | `TELEGRAM_WEBHOOK_SECRET` | *(Opcional)* Secreto que Telegram enviará en cabecera; debe coincidir con el configurado al registrar el webhook |
   | `OAUTH_ENCRYPTION_KEY` | Clave AES-256 en hex para cifrar tokens OAuth en reposo. Genera con: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `GITHUB_CLIENT_ID` | *(Opcional)* Client ID de la GitHub OAuth App |
   | `GITHUB_CLIENT_SECRET` | *(Opcional)* Client Secret de la GitHub OAuth App |
   | `GOOGLE_CLIENT_ID` | *(Opcional)* Client ID del proyecto en Google Cloud |
   | `GOOGLE_CLIENT_SECRET` | *(Opcional)* Client Secret del proyecto en Google Cloud |

Referencia de nombres: [.env.example](.env.example).

---

## Paso 6 — Arrancar la aplicación web

Desde la **raíz** del repo:

```bash
npm run dev
```

Por defecto Turbo ejecuta el `dev` de cada paquete; la app suele quedar en **http://localhost:3000**.

Flujo esperado:

1. **Registro** en `/signup` o **login** en `/login`.
2. **Onboarding** (perfil, agente, herramientas, revisión).
3. **Chat** en `/chat` y **ajustes** en `/settings`.

---

## Paso 7 — Probar el chat con el modelo

1. Confirma que `OPENROUTER_API_KEY` está en `apps/web/.env.local`.
2. En el onboarding, activa al menos las herramientas básicas (`get_user_preferences`, `list_enabled_tools`) si quieres probar *tool calling*.
3. Escribe un mensaje en `/chat`. Si la clave o el modelo fallan, revisa la consola del servidor (terminal donde corre `npm run dev`).

El modelo por defecto está definido en `packages/agent/src/model.ts` (OpenRouter, `openai/gpt-4o-mini`). Puedes cambiarlo ahí si lo necesitas.

---

## Paso 8 — GitHub (opcional)

La integración con GitHub permite al agente listar repositorios e issues, y crear nuevos (con confirmación del usuario).

1. En [GitHub → Settings → Developer settings → OAuth Apps](https://github.com/settings/developers), crea una nueva OAuth App:
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:3000/api/auth/github/callback`
2. Copia **Client ID** → `GITHUB_CLIENT_ID` y genera un **Client Secret** → `GITHUB_CLIENT_SECRET` en `apps/web/.env.local`.
3. En la app, ve a **Ajustes** → **GitHub** → **Conectar con GitHub**.

Al conectar, las herramientas de GitHub se habilitan automáticamente. El agente puede crear issues y repositorios, pero ambas acciones requieren confirmación explícita del usuario antes de ejecutarse.

---

## Paso 9 — Google Calendar (opcional)

La integración con Google Calendar permite al agente listar los próximos eventos y confirmar asistencia (con confirmación del usuario).

1. En [Google Cloud Console](https://console.cloud.google.com):
   - Crea un proyecto (o usa uno existente).
   - Habilita la **Google Calendar API**.
   - En **APIs & Services → Credentials**, crea un **OAuth 2.0 Client ID** de tipo *Web application*:
     - **Authorized redirect URIs**: `http://localhost:3000/api/auth/google/callback`
2. Copia **Client ID** → `GOOGLE_CLIENT_ID` y **Client Secret** → `GOOGLE_CLIENT_SECRET` en `apps/web/.env.local`.
3. En la app, ve a **Ajustes** → **Google Calendar** → **Conectar Google Calendar**.

Al conectar, las herramientas de Google Calendar se habilitan automáticamente. Los tokens se almacenan cifrados con AES-256-GCM y se renuevan automáticamente con el `refresh_token`.

---

## Paso 10 — Telegram (opcional)

Telegram **exige HTTPS** para webhooks. En local:

1. Crea el bot con BotFather y copia el token → `TELEGRAM_BOT_TOKEN` en `apps/web/.env.local`.
2. Elige un secreto aleatorio → `TELEGRAM_WEBHOOK_SECRET` (mismo valor usarás al registrar el webhook).
3. Expón tu app local con un túnel HTTPS, por ejemplo:

   ```bash
   ngrok http 3000
   ```

   Usa la URL HTTPS que te dé ngrok (p. ej. `https://abc123.ngrok-free.app`).

4. Con la app en marcha, visita en el navegador (sustituye la URL base):

   `https://TU_URL_NGROK/api/telegram/setup`

   Eso llama a `setWebhook` de Telegram apuntando a `/api/telegram/webhook` y, si definiste secreto, lo asocia al webhook.

5. En la web, entra a **Ajustes** → **Telegram** → **Generar código de vinculación**.
6. En Telegram, envía al bot: `/link TU_CODIGO` (el código que te muestra la web).

Después de vincular, los mensajes al bot usan el mismo pipeline que el chat web.

---

## Comandos útiles

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Desarrollo (monorepo) |
| `npm run build` | Build de todos los paquetes que definan `build` |
| `npm run lint` | Lint |
| `cd apps/web && npx next build` | Build solo de la app Next (útil para comprobar tipos antes de desplegar) |

---

## Documentación adicional

- [docs/brief.md](docs/brief.md) — visión y brief original.
- [docs/architecture.md](docs/architecture.md) — arquitectura técnica del MVP.
- [docs/plan.md](docs/plan.md) — fases y decisiones de implementación.

---

## Problemas frecuentes

- **Redirecciones infinitas o “no auth”**: revisa `Site URL` y `Redirect URLs` en Supabase y que `.env.local` esté en **`apps/web`**.
- **Errores al guardar perfil o mensajes**: confirma que ejecutaste la migración SQL y que RLS no bloquea por falta de sesión (debes estar logueado con el mismo usuario).
- **Chat sin respuesta / 500 en `/api/chat`**: `OPENROUTER_API_KEY`, cuota en OpenRouter o modelo en `model.ts`.
- **Telegram no responde**: webhook debe ser HTTPS; token y secreto correctos; visita de nuevo `/api/telegram/setup` si cambias la URL pública.
- **GitHub/Google: redirige a `/settings?github=error` o `?google=error`**: revisa que las variables `CLIENT_ID`, `CLIENT_SECRET` y `OAUTH_ENCRYPTION_KEY` estén en `apps/web/.env.local` y que la Authorized callback URI en la OAuth App coincida exactamente.
- **El agente dice que no tiene acceso al calendario o GitHub**: desconecta y vuelve a conectar la integración desde Ajustes para que las herramientas se habiliten automáticamente.
- **Google Calendar: no devuelve `refresh_token`**: asegúrate de que en el flujo OAuth se pasan `access_type=offline` y `prompt=consent` (ya incluidos). Si ya autorizaste antes sin `offline`, revoca el acceso en [myaccount.google.com/permissions](https://myaccount.google.com/permissions) y reconecta.

Si quieres, el siguiente paso natural es desplegar **Vercel** (o similar) para `apps/web`, definir las mismas variables de entorno en el panel del proveedor y usar la URL de producción en Supabase y en el webhook de Telegram.
