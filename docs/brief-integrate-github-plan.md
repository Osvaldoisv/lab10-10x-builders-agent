# Plan: Integración Real de GitHub

## Context

El producto tiene stubs de GitHub en `packages/agent/src/tools/adapters.ts` que devuelven datos vacíos. El brief pide reemplazarlos con una integración OAuth real, cifrar el token con AES-256-GCM, mostrar botones de confirmación en web y Telegram, y corregir el bug donde la API detecta confirmaciones buscando strings en el texto de respuesta.

---

## Archivos Críticos

| Archivo | Acción |
|---|---|
| `packages/agent/src/tools/catalog.ts` | Agregar `github_create_repo` |
| `packages/agent/src/tools/adapters.ts` | Reemplazar stubs por Octokit, agregar githubToken al contexto |
| `packages/agent/src/graph.ts` | Detener grafo en pending_confirmation, output estructurado |
| `apps/web/src/app/api/chat/route.ts` | Descifrar token, pasar al agente, usar campo estructurado |
| `apps/web/src/app/api/telegram/webhook/route.ts` | Descifrar token, pasar al agente |
| `apps/web/src/app/settings/settings-form.tsx` | Sección GitHub OAuth |
| `apps/web/src/app/settings/page.tsx` | Leer estado de integración GitHub |
| `apps/web/src/app/chat/chat-interface.tsx` | Botones Aprobar/Cancelar |

**Archivos nuevos:**

| Archivo | Propósito |
|---|---|
| `packages/db/src/crypto.ts` | Cifrado AES-256-GCM |
| `apps/web/src/app/api/auth/github/route.ts` | Inicia OAuth (redirect a GitHub) |
| `apps/web/src/app/api/auth/github/callback/route.ts` | Recibe código, cifra token, guarda en DB |
| `apps/web/src/app/api/chat/confirm/route.ts` | Web: Aprobar/Cancelar tool call |

---

## Pasos de Implementación

### Paso 1 — Utilidad de Cifrado (`packages/db/src/crypto.ts`)

Implementar `encryptToken(plaintext, key)` y `decryptToken(ciphertext, key)` con AES-256-GCM usando Node.js `crypto`. El key viene de `OAUTH_ENCRYPTION_KEY` (hex de 32 bytes). Exportar desde `@agents/db`.

### Paso 2 — Variables de Entorno

Agregar a `.env.local`:
```
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
OAUTH_ENCRYPTION_KEY=<32-byte-hex>
```

### Paso 3 — OAuth Flow

**`/api/auth/github/route.ts`** — GET handler que redirige a:
```
https://github.com/login/oauth/authorize?client_id=...&scope=repo,user&state=<userId>
```

**`/api/auth/github/callback/route.ts`** — GET handler que:
1. Intercambia `code` por access token via `POST https://github.com/login/oauth/access_token`
2. Cifra el token con `encryptToken`
3. Hace upsert en `user_integrations` con `provider='github'`, `encrypted_tokens`, `status='active'`
4. Redirige a `/settings?github=connected`

### Paso 4 — Settings UI (`settings-form.tsx` + `page.tsx`)

En `page.tsx`: leer `user_integrations` para saber si hay integración GitHub activa y pasar `githubConnected: boolean` + `githubLogin: string | null` al form.

En `settings-form.tsx`: agregar sección "GitHub" después de "Telegram":
- Si conectado: mostrar `"Conectado como @{login}"` + botón "Desconectar" (llama a `/api/auth/github/disconnect`)
- Si no: botón "Conectar con GitHub" → link a `/api/auth/github`

Agregar `github_create_repo` a `TOOL_IDS` en el form.

### Paso 5 — Catálogo de Tools (`catalog.ts`)

Agregar entrada:
```ts
{
  id: "github_create_repo",
  risk: "high",
  requires_integration: "github",
  // owner, name, description, private
}
```

### Paso 6 — Token en el Agente (`graph.ts` + `adapters.ts`)

**`AgentInput`**: agregar `githubToken?: string`

**`ToolContext`**: agregar `githubToken?: string`

**`buildLangChainTools`**: recibir token del contexto y pasarlo a cada tool de GitHub.

**`adapters.ts`**: reemplazar stubs con llamadas reales a la API de GitHub:
- `github_list_repos`: `GET /user/repos` con header `Authorization: token {githubToken}`
- `github_list_issues`: `GET /repos/{owner}/{repo}/issues`
- `github_create_issue` (con confirmación): si aprobado → `POST /repos/{owner}/{repo}/issues`
- `github_create_repo` (con confirmación, risk=high): si aprobado → `POST /user/repos`

Instalar `@octokit/rest` en el package de agent.

### Paso 7 — Detener el Grafo en Confirmación (`graph.ts`)

**Problema actual**: El grafo continúa después de que un tool devuelve `pending_confirmation`, y la API detecta la confirmación buscando el string `"pending_confirmation"` en la respuesta del LLM (línea 91 de `chat/route.ts`). Esto es frágil.

**Solución**: 
1. En `toolExecutorNode`: detectar si algún resultado de tool contiene `pending_confirmation: true`. Si sí, guardar en el estado del grafo `hasPendingConfirmation: true` junto con el objeto de confirmación.
2. En `shouldContinue`: si `state.hasPendingConfirmation` → devolver `"end"`.
3. `runAgent` retorna `AgentOutput` con `pendingConfirmation: { tool_call_id, message } | null`.

Agregar al estado del grafo:
```ts
hasPendingConfirmation: Annotation<boolean>({ default: () => false }),
pendingConfirmationData: Annotation<Record<string, unknown> | null>({ default: () => null }),
```

### Paso 8 — Rutas del Agente (`chat/route.ts` + `telegram/webhook/route.ts`)

En ambas rutas:
1. Al cargar `integrations`, buscar la de GitHub con `status='active'`
2. Descifrar con `decryptToken(integration.encrypted_tokens, process.env.OAUTH_ENCRYPTION_KEY)`
3. Pasar `githubToken` a `runAgent`

En `/api/chat/route.ts` — reemplazar el string-matching (línea 91) por:
```ts
return NextResponse.json({
  response: result.pendingConfirmation ? null : result.response,
  pendingConfirmation: result.pendingConfirmation ?? null,
  toolCalls: result.toolCalls,
});
```

### Paso 9 — Endpoint de Confirmación Web (`/api/chat/confirm/route.ts`)

POST con body `{ tool_call_id, action: "approve" | "reject" }`:
1. Autenticar usuario
2. Verificar que el tool_call pertenece al usuario (join por session)
3. Actualizar `tool_calls.status` a `"approved"` o `"rejected"`
4. Retornar `{ ok: true }`

### Paso 10 — Botones en Chat Web (`chat-interface.tsx`)

Cuando la respuesta tiene `pendingConfirmation`:
- Mostrar el mensaje de confirmación
- Mostrar dos botones: **Aprobar** y **Cancelar**
- Al hacer clic: POST a `/api/chat/confirm` con `{ tool_call_id, action }`
- Después de confirmar: mostrar mensaje de resultado

---

## Flujo Completo Post-Implementación

```
Usuario → /api/chat → runAgent → LLM llama github_create_issue
  → tool detecta needsConfirm=true
  → crea tool_call en DB con status=pending_confirmation
  → devuelve { pending_confirmation: true, tool_call_id, message }
  → toolExecutorNode detecta esto, setea hasPendingConfirmation=true en estado
  → shouldContinue retorna "end" (grafo se detiene)
  → runAgent retorna { pendingConfirmation: { tool_call_id, message } }
  → /api/chat retorna { response: null, pendingConfirmation: {...} }
  → Web: muestra botones Aprobar/Cancelar
  → Usuario hace clic → POST /api/chat/confirm → DB actualiza status
  → Telegram: inline buttons ya funcionan via webhook callback
```

---

## Verificación

1. **OAuth**: ir a `/settings`, hacer clic en "Conectar con GitHub", autorizar en GitHub, verificar redirección y que aparece "Conectado como @user".
2. **Token cifrado**: verificar en Supabase que `user_integrations.encrypted_tokens` no es texto plano.
3. **Tools reales**: pedir al agente "lista mis repos de GitHub" y verificar respuesta real.
4. **Confirmación web**: pedir "crea un issue en repo X", verificar que aparecen botones Aprobar/Cancelar, hacer clic, verificar que el issue se crea en GitHub.
5. **Confirmación Telegram**: mismo flujo desde Telegram, verificar inline buttons.
6. **Desconectar**: verificar que el botón desconectar revoca la integración y el agente ya no puede usar tools de GitHub.
