Necesito integrar **GitHub** en el producto para que el usuario conecte su cuenta desde **Settings** y el agente pueda trabajar con sus repositorios e issues usando **sus permisos**.

### Objetivo

Quitar los stubs actuales de GitHub y reemplazarlos por una integración real con **OAuth App de GitHub**.

### Lo que se necesita

1. **Conectar GitHub desde Settings**
Agregar una seccion de GitHub en Settings con un boton para conectar la cuenta.
El flujo debe ser el normal de OAuth: el usuario va a GitHub, autoriza, vuelve al callback y se guarda la conexión.
Si ya está conectado, debe verse el estado y existir opción para desconectar.

2. **Guardar el token de forma segura**
El token de GitHub no puede quedarse en texto plano.
Debe cifrarse antes de guardarlo en la base de datos usando 'AES-256-GCM' y una variable de entorno *OAUTH_ENCRYPTION_KEY*.
El token solo se usa en servidor, nunca se expone al cliente.

3. **Usar herramientas reales de GitHub**
Reemplazar las herramientas falsas por llamadas reales a la API de GitHub:

* listar repositorios
* listar issues
* crear issue
* crear repositorio

4. **Pedir confirmación en acciones sensibles**
Las acciones que crean cosas, como crear un issue o un repo, deben pedir aprobación antes de ejecutarse.
En web debe mostrarse con botones de **Aprobar** y **Cancelar**.
En Telegram debe hacerse con **inline buttons**.

5. **Evitar el loop de confirmacion**
* cuando una herramienta necesite confirmación, el grafo debe detenerse de inmediato
* debe devolver un ** resultado estructurado **
* la confirmación solo se resuelve con botones de UI, nunca con texto libre
* la API no debe detectar esto buscando strings en la respuesta del modelo, sino usando ese dato estructurado

6. **Pasar el token al agente**
Las rutas que llaman al agente, como */api/chat' y el webhook de Telegram, deben:

* cargar la integración de GitHub del usuario
* descifrar el token
* pasarlo al agente en un campo separado para que las tools lo usen