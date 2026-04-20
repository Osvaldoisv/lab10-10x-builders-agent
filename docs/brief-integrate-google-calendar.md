# Brief: Integración de Google Calendar (LangGraph + OAuth)

Necesito integrar **Google Calendar** en el producto para que el usuario conecte su cuenta desde el frontend y el agente pueda gestionar su agenda (lectura y confirmaciones) utilizando **sus propios permisos**.

---

### Objetivo
Implementar un flujo de autenticación con **Google OAuth 2.0** y desarrollar dos herramientas (tools) específicas para el agente de LangGraph que permitan interactuar con el calendario del usuario en tiempo real.

---

### Lo que se necesita

#### 1. Login con Google en el Frontend
* Agregar un botón de **"Conectar Google Calendar"** en la sección de Settings.
* Implementar el flujo normal de OAuth 2.0: el usuario autoriza en Google, vuelve al callback y se guarda la conexión.
* Es imperativo solicitar `access_type='offline'` para obtener el **refresh_token**, permitiendo que el bot actúe sin que el usuario esté logueado.
* Si ya está conectado, debe mostrarse el estado "Conectado" y la opción de desconectar.

#### 2. Almacenamiento Seguro de Credenciales
* Los tokens (access y refresh) no pueden guardarse en texto plano.
* Deben cifrarse en la base de datos usando **AES-256-GCM** y la variable de entorno `OAUTH_ENCRYPTION_KEY`.
* El proceso de cifrado/descifrado debe ocurrir solo en el servidor.

#### 3. Implementación de Tools (LangGraph)
Crear tools para interactuar con la API de Google Calendar:

* **Tool: `get_upcoming_events`**
    * Consulta la API (`events.list`) con `timeMin` configurado a la hora actual.
    * Debe devolver una lista limpia con: ID, resumen (título), fecha/hora de inicio y estado de confirmación.
* **Tool: `confirm_attendance`**
    * Utiliza el método `patch` o `update` para cambiar el `responseStatus` del usuario a `accepted`.
    * Debe recibir el `event_id` como parámetro.

#### 4. Pedir confirmación en acciones sensibles
* La herramienta de **confirmar asistencia** debe pedir aprobación antes de ejecutarse.
* En el cliente web se deben mostrar botones de **Aprobar** y **Cancelar**.
* En Telegram se debe implementar mediante **inline buttons**.

#### 5. Gestión del Flujo (Evitar Loops)
* Cuando la herramienta de confirmación sea invocada, el grafo de LangGraph debe **detenerse (interrupt)** inmediatamente.
* La herramienta debe devolver un **resultado estructurado** que el frontend identifique para renderizar los botones.
* La confirmación solo se resuelve mediante la interacción con los botones de la UI, nunca procesando texto libre del usuario como validación.

#### 6. Inyección de Tokens al Agente
Las rutas que llaman al agente (API o webhooks) deben:
1. Buscar la integración de Google del usuario.
2. Descifrar los tokens.
3. Validar si el token sigue vigente o refrescarlo si es necesario.
4. Pasar las credenciales al contexto de las herramientas para que puedan realizar las peticiones a Google.

---

### Especificaciones Técnicas
* **Scopes:** `https://www.googleapis.com/auth/calendar.events` (mínimo necesario).
* **Librería sugerida:** `google-api-python-client` y `google-auth-oauthlib`.
* **Seguridad:** Implementar manejo de estados (`state`) en el flujo OAuth para prevenir ataques CSRF.