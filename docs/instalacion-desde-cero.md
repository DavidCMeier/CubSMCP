# Instalar el MCP de Cubase desde cero

[English](installation.md) · **Español**

Esta guía parte de un Mac sin nada instalado y termina con Claude controlando Cubase 13. Está probada con Cubase Pro 13.0.55 en español.

Calcula unos 20 minutos.

En un Mac con Intel, mira antes [Mac con Intel](#mac-con-intel): ahí no conviene instalar con Homebrew.

## 0. Qué vas a montar

```
Claude ──> servidor cubase-mcp (Node) ──bus IAC "MCP to Cubase"──> script MIDI Remote ──> Cubase 13
                    ^                                                       │
                    └────────────── bus IAC "MCP from Cubase" <─────────────┘
```

Cubase no tiene API pública. El servidor habla con un script de MIDI Remote que se ejecuta dentro de Cubase, a través de dos buses MIDI virtuales del sistema (IAC).

## 1. Herramientas del sistema

1. Instala Homebrew si no lo tienes (https://brew.sh).
2. Instala Node, ffmpeg y git:

   ```bash
   brew install node ffmpeg git
   ```

3. Comprueba que Node es la versión 20 o superior:

   ```bash
   node -v
   ```

ffmpeg es lo que permite a Claude "oír": medir el loudness, los picos y el balance de frecuencias de los archivos de audio.

### Mac con Intel

Homebrew 7 ya no publica paquetes precompilados nuevos para los Mac Intel, así que `brew install ffmpeg` puede pasarse mucho rato compilando. En Intel:

- **Node:** usa el instalador oficial (**macOS Installer (.pkg)**, versión LTS) de https://nodejs.org/en/download. Queda en `/usr/local/bin/node`.
- **ffmpeg y ffprobe:** usa los binarios estáticos para Intel de https://evermeet.cx/ffmpeg/, la web que enlaza ffmpeg.org para macOS Intel. Descarga los `.zip` de la versión publicada, descomprímelos y cópialos:

  ```bash
  sudo mkdir -p /usr/local/bin
  sudo mv ffmpeg ffprobe /usr/local/bin/
  sudo xattr -dr com.apple.quarantine /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
  ```

  El `xattr` quita la marca de "descargado de internet"; sin eso macOS bloquea los binarios, porque no están firmados.
- **git:** viene con las herramientas de línea de comandos (`xcode-select --install`). También puedes descargar el repositorio desde GitHub con **Code > Download ZIP**.
- La librería MIDI trae binario para Intel: no hace falta Xcode.
- En la configuración de Claude del paso 6, usa `/usr/local/bin/node` y pon las rutas de ffmpeg con `CUBASE_MCP_FFMPEG` y `CUBASE_MCP_FFPROBE`.

## 2. Descargar y compilar el servidor

```bash
mkdir -p ~/repos && cd ~/repos
git clone https://github.com/DavidCMeier/CubSMCP.git
cd CubSMCP
npm install
npm run build
npm test
```

`npm test` tiene que terminar con `fail 0`.

Con npm 11 puede salir el aviso `npm warn install-scripts` sobre `@julusian/midi`. Se puede ignorar: ese script solo comprueba el binario precompilado de la librería MIDI, que ya viene en el paquete.

## 3. Crear los dos buses MIDI (IAC)

1. Abre **Configuración de Audio MIDI**, que está en Aplicaciones > Utilidades.
2. Ve a **Ventana > Mostrar estudio MIDI**.
3. Haz doble clic en **Driver IAC**.
4. Marca **El dispositivo está conectado**.
5. En **Puertos**, añade dos buses con el botón **+** y ponles exactamente estos nombres:
   - `MCP to Cubase`
   - `MCP from Cubase`
6. Pulsa **Aplicar**.

## 4. Instalar el script dentro de Cubase

```bash
cd ~/repos/CubSMCP
npm run install:script
```

Esto copia el script a `~/Documents/Steinberg/Cubase/MIDI Remote/Driver Scripts/Local/MCP/CubaseBridge/`.

## 5. Configurar Cubase

1. Abre Cubase **después** de crear los buses IAC y carga cualquier proyecto.
2. Ve a **Estudio > Configuración de estudio > Configuración de puertos MIDI**. En los dos puertos `MCP ...`, desmarca **"En 'Todas las entradas MIDI'"**. Si no lo haces, los mensajes del MCP entran en tus pistas MIDI.
3. Abre la pestaña **MIDI Remote** de la zona inferior de la ventana del proyecto. Debería aparecer **MCP CubaseBridge**.
4. Si no aparece, pulsa **+** (añadir superficie) y elige:
   - fabricante `MCP`
   - modelo `CubaseBridge`
   - entrada `MCP to Cubase`
   - salida `MCP from Cubase`
5. Recomendado: activa el **Control Room** en Estudio > Configuración de audio, si quieres que Claude controle el nivel de escucha.

**Cada vez que actualices el script** con `npm run install:script`, recárgalo a mano. En el **Gestor MIDI Remote**, abre el menú de **Scripting Tools** y elige **Reload Scripts**. La herramienta `cubase_reload_script` no consigue recargarlo.

## 6. Conectar el servidor a Claude

### Claude Code (terminal, o la pestaña Code de la app)

```bash
claude mcp add cubase --scope user --env CUBASE_MCP_ENABLE_UI=1 --env CUBASE_MCP_TIMEOUT_MS=8000 -- node ~/repos/CubSMCP/dist/index.js
claude mcp get cubase
```

Tiene que aparecer `Status: ✔ Connected`.

`CUBASE_MCP_TIMEOUT_MS=8000` sube el tiempo de espera de 4 a 8 segundos. Con proyectos grandes, 4 segundos se quedan cortos: en un proyecto de 137 canales hubo muchos timeouts con el valor por defecto.

### Claude Desktop (chat)

Edita `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cubase": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/TU_USUARIO/repos/CubSMCP/dist/index.js"],
      "env": {
        "CUBASE_MCP_ENABLE_UI": "1",
        "CUBASE_MCP_TIMEOUT_MS": "8000"
      }
    }
  }
}
```

Usa rutas absolutas y reinicia Claude Desktop. En `command` pon la ruta que da `which node`: `/opt/homebrew/bin/node` con Homebrew en Apple Silicon, `/usr/local/bin/node` con el instalador oficial o en Intel. La app no ve el PATH de Terminal, así que si ffmpeg no está en `/usr/bin`, añade también `"CUBASE_MCP_FFMPEG"` y `"CUBASE_MCP_FFPROBE"` con sus rutas absolutas (`which ffmpeg ffprobe`).

**Después de cada `npm run build`** hay que reiniciar el servidor para que cargue el código nuevo. En Claude Code basta con abrir una sesión nueva. En Claude Desktop, reinicia la app.

### Permisos de Claude Code

En modo automático, Claude Code pasa cada llamada por un clasificador que decide si se ejecuta. En la prueba del 14 de octubre denegó `ui_click_menu` con "Guardar como...", "Comandos de teclado..." y "Exportar > Mezcla de audio...", y también `ui_key 'f9'`. Esc y "Activar metrónomo" sí pasaron. Después de la primera negativa denegó también lecturas (`cubase_get_raw_values`, `ui_front_window`), así que no se pudo verificar ni restaurar nada. La llamada denegada no llega al servidor: no es un fallo del MCP.

La solución es darle reglas de permisos. Añade este bloque a `~/.claude/settings.json` para todos los proyectos, o a `.claude/settings.local.json` dentro de la carpeta donde abres Claude Code:

```json
{
  "permissions": {
    "allow": ["mcp__cubase"],
    "ask": [
      "mcp__cubase__ui_click_menu",
      "mcp__cubase__ui_key",
      "mcp__cubase__ui_keystroke",
      "mcp__cubase__ui_type_text",
      "mcp__cubase__cubase_run_command",
      "mcp__cubase__cubase_run_command_sequence",
      "mcp__cubase__cubase_undo",
      "mcp__cubase__cubase_save_project",
      "mcp__cubase__cubase_export_audio_mixdown",
      "mcp__cubase__cubase_create_bus_for_selection",
      "mcp__cubase__cubase_set_raw_value",
      "mcp__cubase__cubase_da_set_parameter"
    ]
  }
}
```

Cómo funciona:

- `allow` con `mcp__cubase` permite todas las herramientas del servidor sin pasar por el clasificador: lecturas, mezcla, snapshots y análisis.
- `ask` te pregunta a ti antes de ejecutar, también en modo automático. Claude Code mira `deny`, después `ask` y después `allow`, así que lo que está en `ask` se pregunta aunque el servidor entero esté en `allow`.
- La lista de `ask` es lo que pulsa teclas o menús, lanza comandos de Cubase, deshace, guarda, exporta, crea buses o escribe valores en bruto. Puedes añadir más; por ejemplo, `mcp__cubase__cubase_transport` si no quieres que grabe sin preguntarte.
- `cubase` es el nombre que diste al servidor en `claude mcp add`. Compruébalo, y mira las reglas activas, con `/permissions`.
- Las lecturas de interfaz (`ui_list_menu`, `ui_front_window`, `ui_list_windows`, `ui_read_focused`) quedan permitidas a propósito: son las que sirven para comprobar y restaurar después de una acción.

Si aun así se deniega una llamada, no hay que repetirla por otra vía (un `osascript` a mano u otra herramienta `ui_*`). El clasificador lo toma como un intento de saltarse la negativa y empieza a denegar también las lecturas. Haz tú la acción en Cubase, o apruébala cuando Claude Code te pregunte.

## 7. Permisos de macOS (para las herramientas de interfaz)

Las herramientas `ui_*` pulsan teclas y menús en Cubase. Para usarlas:

1. Abre **Ajustes del Sistema > Privacidad y seguridad > Accesibilidad**.
2. Activa la app que lanza el servidor: **Claude** si usas la app, o **Terminal** / **iTerm** si usas `claude` en un terminal.
3. Reinicia esa app.

Si macOS pide además permiso de **Automatización** ("quiere controlar System Events"), acéptalo. Si lo denegaste, está en **Privacidad y seguridad > Automatización**.

Cuando algo falla, el error de las herramientas `ui_*` dice qué revisar según el código de macOS:

| Mensaje | Qué revisar |
|---|---|
| `macOS denied UI control` | El permiso de Accesibilidad de este paso. |
| `macOS denied sending Apple events` | El permiso de Automatización. |
| `Cubase process "..." not found` | Que Cubase esté abierto y que `CUBASE_MCP_APP_NAME` sea el nombre de su proceso (por defecto `Cubase 13`; lo ves en el Monitor de Actividad). |
| `Menu "..." has no item "..."` | El nombre del menú. El error trae la lista de los que hay. |
| `... is not the frontmost app` | Otra app se puso delante. No se envió nada. |

Al final del mensaje va el texto original de macOS, en el idioma del sistema.

### Menús en español

Los nombres de menú van en el idioma de Cubase. Con Cubase en español es `["Archivo","Exportar","Mezcla de audio..."]`, no `["File","Export",...]`. Más cosas que se vieron en la prueba:

- **Detener** no está directamente en Transporte, sino en un submenú: `["Transporte","Comandos de transporte","Detener"]`.
- **Deshacer** lleva detrás la última acción ("Deshacer Ajustar nombre de pista"), así que no hay una ruta fija. Usa `cubase_undo`.
- **Preferencias** se llama "Ajustes…", con el carácter "…" (U+2026). `ui_click_menu` acepta "Ajustes..." con tres puntos.
- **Pegar** aparece dos veces en Edición, y macOS añade sus propios elementos, como "Herramientas de escritura".

Para descubrir los nombres, usa `ui_list_menu`: sin `menu` lista la barra de menús, con `menu: "Transporte"` lista ese menú y con `submenu: ["Comandos de transporte"]` baja un nivel. Marca los elementos desactivados, los que abren un submenú y los que llevan marca (`checked`), y da el atajo de cada elemento (`shortcut`, p. ej. `"⇧⌘Z"`, con `modifiers` y `key`). `ui_click_menu` compara sin mayúsculas, sin tildes y sin distinguir "..." de "…", pero nunca por prefijo, y no pulsa elementos desactivados.

Cuando hay una herramienta que no depende del idioma, es mejor: `cubase_transport` para parar o reproducir, `cubase_undo` para deshacer y `cubase_run_command` para los comandos de teclado.

### Teclas y ventanas

- `ui_key`, `ui_keystroke`, `ui_type_text` y `ui_click_menu` traen Cubase delante y comprueban que sigue delante justo antes de enviar. Después devuelven la app que quedó delante (`frontApp`, `cubaseFrontmost`), la ventana frontal de Cubase y las ventanas que se abrieron o cerraron (`opened`, `closed`). Si solo cambia una ventana sin título, lo dicen en `notes`, porque no se sabe cuál es.
- F1 abre la ayuda en línea en el navegador, que se queda delante. F4 abre "Conexiones de audio". `ui_key` acepta de f1 a f12 y las teclas del teclado numérico (`pad0`..`pad9`, `pad.`, `pad+`, `pad-`, `pad*`, `pad/`, `padenter`, `padequals`, `padclear`), que en los comandos por defecto de Cubase manejan el transporte (`pad0` es Detener).
- Los elementos que abren una ventana la alternan. El primer `ui_click_menu ["Estudio","Conexiones de audio..."]` la trae delante y el segundo la cierra: mira `opened` y `closed`.
- Un atajo ejecuta lo que Cubase tenga asignado, igual que si lo pulsaras tú. Cmd+Shift+Z es Rehacer: con un rehacer pendiente, un "atajo inofensivo" puede rehacer una acción del proyecto. Antes de probar atajos, mira el menú Edición con `ui_list_menu`, que da el atajo de cada elemento. Una letra mayúscula se envía con Shift.
- `ui_front_window` y `ui_list_windows` no activan Cubase. Muchas ventanas de Cubase no tienen título, así que `ui_front_window` da también la primera ventana con título.
- `ui_read_focused` lee la ventana y el elemento con foco (rol, título, descripción y valor) sin pulsar nada ni activar Cubase. Antes de `ui_type_text` dice si hay un campo de texto con foco, y después deja leer lo escrito. Cubase 13 no expone a Accesibilidad sus propios campos de nombre (el de la pista en la ventana de proyecto es uno): ahí el elemento sale sin valor o no sale, y el nombre de una pista se comprueba con `cubase_get_channel`.
- Con Cubase detrás, macOS oculta los editores de plugin: tras `cubase_set_insert` o `cubase_set_strip_module` con `openEditor: true`, el editor no sale en la lista de ventanas hasta que Cubase pasa delante (`ui_list_windows` con `activate: true`). La ventana de Channel Settings sí sale. Para saber si un editor está abierto, lo fiable es `editorOpen` en `cubase_get_channel_strip`. Al cerrar una ventana puede quedar un momento otra sin título, muy pequeña (67×19 en la prueba); es de Cubase y desaparece sola.

## 8. Configurar la exportación (para medir de forma fiable)

Los medidores en directo del bridge sirven para el gain staging, pero muestrean el medidor de Cubase y pueden marcar hasta ~1 dB menos en transitorios cortos. Para medidas exactas (picos, LUFS, balance tonal), Claude exporta stems y los analiza con ffmpeg. Configúralo una sola vez:

1. Ve a **Archivo > Exportar > Mezcla de audio...**.
2. Activa **Exportación por lotes de canales** y marca los canales que quieras analizar.
3. Elige WAV, 24 bits y la frecuencia del proyecto. Pon como carpeta, por ejemplo, `~/Music/cubase-mcp-stems/<proyecto>`.
4. Desmarca las opciones de importar al proyecto.
5. Exporta una vez a mano para que Cubase guarde la configuración. Después, `cubase_export_audio_mixdown` repite la exportación con esa misma configuración. Pásale la carpeta en `folder` para que espere a los archivos y diga cuáles ha escrito: Cubase no confirma la exportación. Del mismo modo, `cubase_save_project` con `projectFile` (la ruta del `.cpr`) comprueba que el proyecto se ha guardado.

## 9. Plantilla con tus cadenas de plugins

Cubase 13 no deja cargar plugins nuevos desde la API. Claude solo puede activar, desactivar y ajustar los que ya están en el proyecto. Por eso:

- Crea una plantilla con tus cadenas por tipo de pista (bombo, caja, bajo, guitarras, voz, mix bus), cargadas y desactivadas.
- Comprueba que **todos los plugins del proyecto están instalados en este Mac**. Si falta uno, Cubase deja el slot vacío, la cadena suena distinta y las medidas no sirven. Lo ves en Estudio > Gestor de plug-ins VST.

## 10. Comprobación final

Pide a Claude, en este orden:

1. `cubase_status`: tiene que mostrar `directAccess: true` e `insertSlotAccess: true`.
2. `cubase_list_channels` con `includeValues: false`: tienen que salir los nombres de tus pistas.
3. `cubase_set_volume` a -6 dB en una pista de prueba, y después `cubase_undo`.
4. `cubase_set_pan` a -30 en la pista de prueba, y después devolverlo a 0.
5. `cubase_focus_channel` en una pista con un plugin activo, y después `cubase_get_plugin_parameters`: tienen que salir los parámetros del plugin, no "Activ.", "Bypass" o "Edición".
6. `audio_analyze_file` sobre cualquier WAV.
7. `ui_list_menu` sin argumentos (la barra de menús) y con `menu: "Archivo"`.

## Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| `Cubase did not answer ... within 4000 ms` | Cubase está ocupado o el proyecto es grande. Sube `CUBASE_MCP_TIMEOUT_MS` a 8000. Las lecturas y las escrituras absolutas ya esperan a que MIDI Remote salga del parón y se reenvían solas; si el error dice "sent once and not resent" es un pulso, una acción o un comando: comprueba si se ha ejecutado antes de repetirlo, porque muchas veces sí. |
| `cubase_status` no responde nunca | La superficie MCP CubaseBridge no está activa en la pestaña MIDI Remote, o los buses IAC no existen o tienen otro nombre. Compruébalo con `cubase_list_midi_ports`. |
| `osascript no tiene permiso para enviar pulsaciones de teclas` | Falta el permiso de Accesibilidad del paso 7. |
| Claude Code deniega `ui_click_menu`, `ui_key` o lecturas en modo automático | Faltan las reglas de permisos de "Permisos de Claude Code" (paso 6). No repitas la llamada por otra vía. |
| `Error opening input ... Invalid data` en análisis | Hay un WAV vacío o roto en la carpeta. El análisis salta esos archivos y los lista. |
| Batería o guitarras en silencio | Faltan plugins (Superior Drummer, amplificadores...). Instálalos o sustitúyelos antes de mezclar. |
| La respuesta de `cubase_list_channels` es enorme | Ya no debería: devuelve valores compactos y solo los envíos con destino. Pide menos campos con `fields`, pagina con `offset`/`limit`, usa `includeValues: false` o consulta canal a canal con `cubase_get_channel`. |
| Al seleccionar una pista se arma la grabación y aparecen WAV de 0 bytes en `Audio/` | Es una preferencia de Cubase: Preferencias > Edición > Proyecto y MixConsole > "Activar grabación en la pista seleccionada". Cada vez que arma una pista, Cubase crea el archivo de la toma. Desactívala para mezclar y borra esos archivos con Archivo > Limpiar. Las herramientas que seleccionan lo indican en `sideEffects` (`armedBySelection`) y aceptan `disarm: true` y `restoreSelection: true`; el servidor no borra archivos. |

Las limitaciones conocidas están en el [README](../README.es.md#límites-de-cubase-13-importante).
