# cubase-mcp

Servidor MCP para controlar **Cubase 13 en macOS** desde Claude (Desktop o Code) y automatizar la parte técnica de la mezcla.

Cubase no tiene API pública, así que la conexión se hace con la vía oficial de Steinberg: un **script de MIDI Remote** (API 1.2) que se ejecuta dentro de Cubase y habla con el servidor MCP por SysEx a través de dos buses IAC.

```
Claude ──MCP (stdio)──> cubase-mcp (Node) ──SysEx/IAC "MCP to Cubase"──> script MIDI Remote ──> Cubase 13
                              ^                                                   │
                              └──────────── SysEx/IAC "MCP from Cubase" <────────┘
                              │
                              └──> ffmpeg (análisis de stems y mezclas: los "oídos")
```

## Qué puede hacer

| Área | Herramientas |
|---|---|
| Diagnóstico | `cubase_status`, `cubase_list_midi_ports`, `cubase_get_script_log` (las peticiones se filtran por número, método y servidor), `cubase_reload_script`, acceso a valores en bruto (también por nombre de canal: `ch[G L Clean].volume` o `{channel, field}`, en cualquier página del banco) |
| Mezclador (todos los canales del banco) | listar canales (con su tipo: audio, instrumento, grupo, FX, VCA, salida...), fader en dB, pan, mute/solo/rec/monitor, lectura y escritura de automatización, fase, ganancia de entrada, low cut, envíos (nivel, on, pre/post), `cubase_apply_mix` para muchos cambios a la vez, paginación del banco (ir a una página o al canal que se pida), canales ocultos en la MixConsole (recuento y `showAll`), lectura del ruteo (`cubase_get_routing`: salida y destinos de los envíos; no se puede cambiar), renombrar canales por DirectAccess (`cubase_rename_channel`) |
| Snapshots | `cubase_snapshot_mix`, `cubase_list_snapshots`, `cubase_restore_mix`, `cubase_delete_snapshot`: toda la MixConsole (todas las páginas del banco), con low cut, identificando cada canal por su UID de Cubase. Con un canal en solo, Cubase muestra mutes y solos implícitos, así que el snapshot no los guarda; la restauración quita los solos antes de restaurar los mutes. Guarda la lectura de automatización de cada canal y no restaura los canales que la tienen activada (`writeAutomated` lo fuerza). La sección Pre y los envíos de los canales MIDI (y de los VCA) se guardan como null. Un snapshot existente no se sobrescribe sin `overwrite: true`; la lista da fecha, canales, `allPages`, versión y tamaño; la restauración admite `dryRun` (solo compara) y filtros por canal (`channels`) y por campo (`fields`) |
| Channel strip (pista seleccionada) | sección Pre completa, EQ de 4 bandas en Hz/dB/Q (Q de 0 a 12) y tipo de filtro por nombre ("Parametric II", "High Pass I"...; `listTypes` da la lista de la banda y cada escritura se comprueba en el display), módulos del strip (gate, compresor, tools, saturador, limitador), 16 slots de inserción (on, bypass, abrir ventana; los vacíos llevan `empty: true`), quick controls y lectura de los quick controls con foco (`cubase_get_focused_quick_controls`). `cubase_get_channel_strip` puede devolver solo algunas secciones (`sections`). `cubase_select_track` avanza una pista, salta a la primera o la última (`to`) o a una pista por su nombre (`name`) |
| Plugins (DirectAccess) | listar y cambiar **cualquier parámetro** de cualquier plugin de inserción, del strip o del instrumento, en unidades reales (dB, Hz, ms) o normalizado, también en lote (`valueInUnits` por elemento); cada escritura dice si Cubase la aplicó (`applied`, `changed`). La lista admite `fields` y `titlesOnly` para respuestas cortas, `tag`/`tags` para leer parámetros sueltos y filtros por título con `match` (`contains`, `exact`, `regex`) y `matchedTotal`; un título que coincide con varios parámetros da error con la lista en vez de escribir el primero. Explorar el árbol de objetos de toda la MixConsole |
| Transporte | play, stop, grabar, ciclo, metrónomo, avanzar y retroceder N segundos, avanzar o retroceder un compás, nudge, colocar el cursor en un tiempo, fijar los localizadores (`set_locators`), "volver a la posición de inicio al parar" (`returnOnStop`), ir a marcadores y localizadores, listar las posiciones de los marcadores (`cubase_list_markers`; Cubase no da sus nombres), Control Room. Cada respuesta trae el cursor y los localizadores (tiempo de DirectAccess), y `cubase_go_to_marker` dice si el marcador existe (`markerFound`). El tempo no se puede leer: Cubase 13 no lo expone a MIDI Remote |
| Comandos | 636 comandos de teclado de Cubase 13 (de los ~1.450 que tiene; `cubase_list_commands` con `includeUnbound` lista también los demás, marcados `inCatalog: false`), más tus macros y presets de Logical Editor. Un nombre que el script no asigna da error antes de enviar nada, con los comandos parecidos. Cubase no confirma los comandos: la respuesta dice `sent` y `confirmed: false`, y con `waitFor` la herramienta espera a que un valor en bruto llegue a un estado o cambie. Start, Stop, StartStop, Record, Cycle y Metronome On se escriben como valores del transporte y sí se confirman |
| Medición | medidores por canal (pico y media RMS del tiempo en reproducción; `cubase_get_meters` filtra por canales o por `onlyWithSignal`), `cubase_measure_levels` (reproduce una sección y mide picos; con `allPages`, una pasada por página del banco), `cubase_gain_stage` (propone o aplica la ganancia de entrada: descuenta el fader, deja fuera grupos, FX, VCA y salidas por su tipo y explica qué excluye). Un marcador que no existe da error antes de reproducir |
| Análisis de audio | LUFS, LRA, true peak, RMS, crest factor, ancho estéreo y correlación, balance tonal por bandas, enmascaramiento entre stems, comparación con referencia |
| Flujo de trabajo | tu flujo en `workflow/mix-workflow.md` (recurso, herramienta y prompt `mix_session`), guardar proyecto (con `projectFile`, comprueba que se escribió), deshacer (dice qué cambió en la página del banco y, con la interfaz activada, qué paso del menú Edición deshizo y cuál queda después, `stepAfter`), crear buses para la selección (devuelve el canal nuevo, el desplazamiento de índices y la salida anterior de las pistas), exportar mezcla o stems (con `folder`, devuelve los archivos escritos) |
| Automatización de la interfaz (opcional) | menús y submenús (listar con atajos y marcas, y pulsar), teclas (F1-F12 y teclado numérico), escribir texto, leer el elemento con foco, ventanas de Cubase. Cada acción dice qué app quedó delante y qué ventanas se abrieron o cerraron. `cubase_rename_channel` en modo `field` abre el campo de nombre para que lo escribas tú (por defecto renombra por DirectAccess, sin interfaz) |

En total, 71 herramientas, 3 recursos y 1 prompt.

## Límites de Cubase 13 (importante)

- **No se pueden cargar plugins nuevos en un slot**. La función existe en la API 1.3, que llega con Cubase 15. Solución: cargar tus cadenas en la **plantilla del proyecto** (desactivadas) y que el agente las active y ajuste.
- **No se puede leer el contenido de los eventos** (notas MIDI, ediciones de audio).
- **Color y orden de las pistas** no se exponen. Para color, usa macros o presets del Project Logical Editor añadidos a `commands/user-commands.txt`.
- **El agente no oye.** Para decidir necesita medidas: medidores en directo o stems exportados analizados con ffmpeg.
- **Los medidores solo existen para los 48 huecos de la página del banco que se ve.** Las estadísticas van por hueco, no por canal. Para medir todo el proyecto, `cubase_measure_levels` y `cubase_gain_stage` aceptan `allPages: true` y reproducen la sección una vez por página.
- **Cubase no confirma los comandos de teclado**, ni dice si había algo que deshacer, guardar o exportar. Las herramientas comprueban lo que pueden (valores del banco, posición del cursor, archivos) y si no, lo dicen con `confirmed: false` o `verified: false`.
- **El historial de la MixConsole no guarda mute ni solo.** Tras un mute, `cubase_undo` deshace el paso anterior (por ejemplo, un fader). Un renombrado por DirectAccess tampoco entra en el historial de edición.
- **Las escrituras de las búsquedas pueden no dejar paso en el historial de la MixConsole.** En la prueba del 15 de octubre, las escrituras de `cubase_set_volume` (búsqueda en dB) no entraron en el historial, y `cubase_undo` deshizo un paso anterior: la ganancia de entrada de otro canal. Con `expect` (`{channel, field}`), `cubase_undo` comprueba que cambió lo esperado y, si cambió otra cosa, lo rehace al momento y da error. Sin `expect`, avisa cuando lo deshecho no es lo último que escribió el servidor. Para revertir escrituras del servidor, lo seguro es `cubase_snapshot_mix` antes y `cubase_restore_mix` después.
- **Con la lectura de automatización activada, la automatización manda.** Cubase sustituye los valores automatizados en cuanto se mueve el cursor, y no dice qué parámetros tienen automatización. Los snapshots guardan `autoRead` por canal y cuentan esos canales; `cubase_restore_mix` no los escribe (salvo el solo) y los lista en `automated`, a no ser que se pase `writeAutomated: true`. `cubase_set_volume`, `cubase_set_pan` y `cubase_apply_mix` avisan cuando el canal la tiene activada.
- **El ruteo no se puede cambiar por la API.** La salida se lee (DirectAccess, "Salida"; `cubase_get_routing` la da junto con los destinos de los envíos), pero Cubase ignora lo que se escribe; los destinos de los envíos y las entradas no se pueden fijar. Por lo mismo, `cubase_create_bus_for_selection` no puede elegir mono o estéreo, la salida ni un plugin para el bus nuevo (sí el nombre, con `name`). Al deshacer un grupo creado con `cubase_create_bus_for_selection`, la pista de origen queda en "Sin bus": `cubase_undo` lo avisa y devuelve la salida que tenía para que la pongas a mano.
- Los valores llegan normalizados (0..1). Para trabajar en dB o Hz, el servidor hace una búsqueda binaria contra lo que muestra Cubase. Tarda alrededor de 1 segundo por valor.
- **El banco del mezclador es una ventana de 48 canales que se mueve por desplazamiento**, no por páginas fijas: `next` avanza 48 sin pasar del último canal y los `shift` la mueven de uno en uno. MIDI Remote no deja leer ni fijar ese desplazamiento, así que el servidor lo deduce de los UID de los canales.
  - Un número (o un texto solo de dígitos, como `"12"`) es un **índice del banco en la página que se ve ahora**: cambia si `cubase_bank` mueve el banco.
  - Cualquier otro texto es un **nombre**: se busca en todas las páginas sin distinguir mayúsculas (exacto, luego prefijo único, luego subcadena única) y el banco vuelve después a su página. Si coinciden varios canales, la llamada falla y los lista; para nombres repetidos se usa `#N` (`"G L#2"` es el segundo "G L" en el orden de la MixConsole). Buscar por nombre en un proyecto de varias páginas tarda unos segundos, porque hay que recorrer el banco.
  - Un objeto `{name, occurrence?, exact?}` exige el nombre completo (sin prefijo ni subcadena, y sin leer `#N`): `{"name": "G L", "occurrence": 2}` es el segundo "G L"; `exact: false` vuelve a permitir prefijo y subcadena. Los errores de ambigüedad listan página, índice y UID de cada candidato.
  - `cubase_bank` con `goToPage` (página N contada desde el primer canal) o `showChannel` (la página donde está un canal) deja el banco ahí; cada respuesta dice `atStart`, `atEnd`, `page` y cuántos canales hay ocultos.
  - Se rechazan los nombres en blanco y los números que no son enteros ≥ 0. Claude Code envía como texto un índice no válido (37.5, -1), y el servidor lo rechaza en vez de buscarlo como nombre.

## Instalación

### 1. Requisitos

```bash
brew install node ffmpeg
```

Node 20 o superior.

### 2. Crear los buses IAC

1. Abre **Configuración de Audio MIDI** y ve a **Ventana > Mostrar estudio MIDI**.
2. Abre el **Driver IAC**.
3. Marca **El dispositivo está conectado**.
4. Añade dos buses llamados exactamente **`MCP to Cubase`** y **`MCP from Cubase`**.

### 3. Evitar que los buses entren en tus pistas

En Cubase, ve a **Studio > Configuración de estudio > Configuración de puertos MIDI** y desmarca **"En 'Todas las entradas MIDI'"** en los dos puertos IAC.

### 4. Compilar e instalar

```bash
cd cubase-mcp
npm install
npm run build
npm run install:script
```

`install:script` copia el script a `~/Documents/Steinberg/Cubase/MIDI Remote/Driver Scripts/Local/MCP/CubaseBridge/`.

### 5. Activar la superficie en Cubase

1. Abre Cubase y carga un proyecto.
2. Abre la pestaña **MIDI Remote** de la zona inferior. Debería aparecer **MCP CubaseBridge**.
3. Si no aparece, pulsa **+ (Añadir superficie de control MIDI)** y configura:
   - fabricante `MCP`
   - modelo `CubaseBridge`
   - entrada `MCP to Cubase`
   - salida `MCP from Cubase`
4. Si cambias el script, recárgalo a mano: en el **Gestor MIDI Remote**, menú **Scripting Tools > Reload Scripts**. Cubase 13 ignora la recarga pedida desde el propio script, así que `cubase_reload_script` solo lo intenta y te avisa si no ha funcionado.

### 6. Conectar a Claude

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cubase": {
      "command": "node",
      "args": ["/RUTA/A/cubase-mcp/dist/index.js"],
      "env": {
        "CUBASE_MCP_ENABLE_UI": "1"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add cubase --env CUBASE_MCP_ENABLE_UI=1 -- node /RUTA/A/cubase-mcp/dist/index.js
```

Para las herramientas `ui_*`, da permiso de **Accesibilidad** a la app que lanza el servidor (Claude o Terminal) en Ajustes del Sistema > Privacidad y seguridad.

### 7. Permisos en Claude Code (modo automático)

En modo automático, Claude Code decide con un clasificador si ejecuta cada herramienta. En la prueba con Cubase 13 denegó `ui_click_menu` ("Guardar como...", "Exportar > Mezcla de audio...") y `ui_key`. Después de la primera negativa denegó también lecturas, como `ui_front_window`, y ya no se pudo comprobar ni restaurar nada. Una llamada denegada no llega al servidor.

Para evitarlo, añade reglas de permisos en `~/.claude/settings.json` (todos los proyectos) o en `.claude/settings.local.json` del proyecto. Con `allow`, la herramienta se ejecuta sin pasar por el clasificador. Con `ask`, Claude Code te pregunta a ti, también en modo automático. `ask` gana a `allow`, así que basta con permitir el servidor entero y pedir confirmación para lo que pulsa teclas o menús, lanza comandos, guarda o exporta:

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

- `cubase` es el nombre con el que añadiste el servidor (`claude mcp add cubase ...`). Si usaste otro, cambia el prefijo. Las reglas activas se ven con `/permissions`.
- Quedan permitidas las lecturas (`ui_list_menu`, `ui_front_window`, `ui_list_windows`, `ui_read_focused`, `cubase_get_*`...) y la mezcla (fader, pan, EQ, plugins, snapshots). Si quieres confirmar algo más, añádelo a `ask`.
- Si Claude Code o tú denegáis una llamada, el agente no debe repetirla por otra vía (`osascript`, otra herramienta `ui_*`). El clasificador lo toma como un intento de saltarse la negativa y empieza a denegar también las lecturas.

## Variables de entorno

| Variable | Por defecto | Uso |
|---|---|---|
| `CUBASE_MCP_PORT_MODE` | `iac` | `virtual` crea puertos CoreMIDI propios en lugar de usar IAC. Cubase tiene que verlos antes de arrancar. |
| `CUBASE_MCP_TO_CUBASE_PORT` | `MCP to Cubase` | Nombre (o parte) del bus de salida hacia Cubase |
| `CUBASE_MCP_FROM_CUBASE_PORT` | `MCP from Cubase` | Nombre (o parte) del bus de entrada desde Cubase |
| `CUBASE_MCP_TIMEOUT_MS` | `4000` | Tiempo máximo de espera por petición |
| `CUBASE_MCP_STALL_RECOVERY_MS` | `25000` | Tiempo total que una lectura o una escritura absoluta espera a que MIDI Remote salga de un parón: hace ping hasta que Cubase contesta y la reenvía (2 veces como mucho). Los pulsos, acciones y comandos no se reenvían nunca: su timeout dice que la respuesta se perdió y que Cubase puede haberlos ejecutado. |
| `CUBASE_MCP_SETTLE_MS` | `150` | Pausa entre escribir un valor y releerlo. Con 60 ms Cubase 13 se bloquea unos 10 s en 1 de cada 3 búsquedas; con 150 ms no se ha bloqueado en 20 pruebas. |
| `CUBASE_MCP_APP_NAME` | `Cubase 13` | Nombre del proceso para la automatización de la interfaz |
| `CUBASE_MCP_ENABLE_UI` | `0` | `1` activa las herramientas `ui_*` |
| `CUBASE_MCP_WORKFLOW_FILE` | `workflow/mix-workflow.md` | Tu flujo de mezcla |
| `CUBASE_MCP_SNAPSHOT_DIR` | `~/.cubase-mcp/snapshots` | Carpeta de snapshots |
| `CUBASE_MCP_FFMPEG` / `CUBASE_MCP_FFPROBE` | `ffmpeg` / `ffprobe` | Rutas de ffmpeg |

En la sección `CONFIG` del script (`cubase-script/template/MCP_CubaseBridge.template.js`) puedes ajustar el tamaño del banco (48 canales por defecto), los envíos, los slots de inserción y si se incluyen los buses de salida. Después, ejecuta `npm run install:script` y recarga el script.

## Selección, plugins y DirectAccess

- **Seleccionar tiene efectos.** El EQ, los inserts, los módulos, los quick controls y los plugins solo se exponen en la pista seleccionada, así que las herramientas con `channel` la seleccionan (una pista ya seleccionada no se vuelve a seleccionar; `cubase_set_prefilter` escribe ganancia, fase y low cut por el banco, sin seleccionar). Con la preferencia "Activar grabación en la pista seleccionada", Cubase además la arma y crea un WAV de 0 bytes en `Audio/` cada vez (Archivo > Limpiar los borra). Las respuestas traen `sideEffects` con la selección anterior, `recordEnabled` y `armedBySelection`; `disarm: true` desarma la pista y `restoreSelection: true` vuelve a seleccionar la anterior al terminar. `openEditor: true` en `cubase_set_channel_state` también selecciona, y admite las mismas dos opciones; además, esa herramienta informa en `sideEffects` de que activar la escritura de automatización activa la lectura y de los estados implícitos de un solo.
- **Slots vacíos y plugins no instalados.** Cubase deja en el slot un objeto con sus propios controles. Leer o escribir parámetros de un slot vacío, de un plugin no instalado o del instrumento de una pista de audio da error; `cubase_list_inserts` y `cubase_get_channel_strip` marcan `missing: true` y no muestran el fabricante de esos plugins, porque Cubase da el suyo.
- **Textos que Cubase no entiende.** Con `display`, Cubase ignora sin error un texto que no entiende. Las herramientas comparan antes y después: un texto ignorado da error y uno que lleva el parámetro a otro valor da `applied: false` con un aviso.
- **Quick controls.** Uno sin parámetro asignado no se escribe (`assigned: false`): Cubase descarta la escritura y, en los enfocados, devuelve la escritura anterior. La API no puede asignarlos.
- **DirectAccess.** Un `objectId` o un tag inexistentes dan error. El scope `controlroom` da error con Control Room desactivado (Cubase lo apunta a la raíz del mezclador). `mixerChannelIndex` es la numeración de DirectAccess (Stereo Out es -1), no el índice del banco: `cubase_da_tree` añade `bankIndex` cuando el canal está en el banco. `cubase_da_find` busca en anchura con un presupuesto de nodos (`maxNodes`, 20.000 por defecto) y avisa con `truncated`.

## Automatización de la interfaz

Las herramientas `ui_*` necesitan `CUBASE_MCP_ENABLE_UI=1` y el permiso de Accesibilidad. Lo que conviene saber:

- **Los menús van en el idioma de Cubase.** En español: `["Archivo","Exportar","Mezcla de audio..."]`. Detener está en un submenú: `["Transporte","Comandos de transporte","Detener"]`. Algunas etiquetas cambian con el proyecto ("Deshacer Ajustar nombre de pista") o llevan "…" (U+2026), como "Ajustes…". Para parar, deshacer o lanzar comandos es mejor `cubase_transport`, `cubase_undo` o `cubase_run_command`, que no dependen del idioma.
- **`ui_list_menu`** sin `menu` lista la barra de menús. Con `menu` y `submenu` baja por los submenús y marca los elementos desactivados, los que abren otro menú y los que llevan marca (`checked`). Cada elemento con atajo trae `shortcut`: el texto que muestra el menú (`"⇧⌘Z"`), `modifiers` y `key`, listos para `ui_keystroke` (un carácter) o `ui_key` (un nombre como `f9` o `pad0`). Solo salen los atajos de los elementos de menú, no los comandos de teclado de Cubase que no están en un menú. `ui_click_menu` compara sin mayúsculas, tildes ni "..."/"…", pero nunca por prefijo. Si un nombre no existe, el error lista los que hay.
- **Las acciones informan de lo que pasó.** `ui_click_menu`, `ui_key`, `ui_keystroke` y `ui_type_text` traen Cubase delante, no envían nada si no se queda delante y devuelven la app que quedó delante (`frontApp`, `cubaseFrontmost`), la ventana frontal y las ventanas que se abrieron o cerraron (`opened`, `closed`). F1 abre la ayuda en el navegador, que se queda delante. Los elementos que abren una ventana la alternan: un segundo clic en "Estudio > Conexiones de audio..." la cierra.
- **Los atajos ejecutan lo que Cubase tenga asignado.** Cmd+Shift+Z es Rehacer: antes de probar un atajo, mira el menú Edición con `ui_list_menu`. Una letra mayúscula se envía con Shift. `ui_key` acepta F1-F12 y el teclado numérico (`pad0`..`pad9`, `pad.`, `pad+`, `pad-`, `pad*`, `pad/`, `padenter`, `padequals`, `padclear`); en los comandos de teclado por defecto de Cubase el teclado numérico maneja el transporte (`pad0` es Detener).
- **`ui_read_focused`** lee, sin pulsar nada ni activar Cubase (salvo con `activate: true`), la ventana y el elemento con foco: rol, título, descripción y valor (`AXValue`). Sirve para comprobar que hay un campo de texto con foco antes de `ui_type_text` y leer lo escrito. Cubase 13 no expone a Accesibilidad sus propios campos de nombre (el de la pista en la ventana de proyecto es uno): ahí el elemento sale sin valor o no sale, y el nombre se comprueba con `cubase_get_channel`.
- **Ventanas.** `ui_front_window` y `ui_list_windows` no activan Cubase. Con Cubase detrás, macOS oculta los editores de plugin, así que no aparecen hasta activarlo (`ui_list_windows` con `activate: true`). Para saber si un editor está abierto, usa `editorOpen` de `cubase_get_channel_strip`. Muchas ventanas de Cubase no tienen título.
- **Errores.** El mensaje dice si falta el permiso de Accesibilidad o de Automatización, si `CUBASE_MCP_APP_NAME` no coincide con el proceso de Cubase o si el menú no existe, y acaba con el texto de macOS.

Más detalles en [docs/instalacion-desde-cero.md](docs/instalacion-desde-cero.md).

## Primera prueba con Cubase (lista de comprobación)

El código se prueba contra una **simulación** de la API de MIDI Remote (`npm test`) y se probó opción por opción con Cubase Pro 13.0.55 real (en español) en octubre de 2026. En una instalación nueva, haz estas comprobaciones en orden:

1. `cubase_status`: tiene que responder y mostrar `directAccess: true` y `insertSlotAccess: true`.
2. `cubase_list_channels`: nombres de pista y valores del fader en dB.
3. `cubase_set_volume` en una pista de prueba a -6 dB, y después `cubase_undo`: tiene que decir qué canal cambió.
4. `cubase_set_channel_state` con mute: comprueba que el mute queda fijo y no alterna.
5. `cubase_focus_channel` y luego `cubase_get_channel_strip`: EQ, inserts y nombres de plugin.
6. `cubase_get_plugin_parameters` sobre un insert.
7. `cubase_get_transport_state`: tiene que traer `position` con el cursor y los localizadores.
8. `cubase_measure_levels` con 10 segundos.

Si algo falla, el registro del script está en `cubase_get_script_log` y en la consola de MIDI Remote (*Scripting Tools: Open Console*). Después de actualizar el servidor, ejecuta `npm run install:script` y recarga el script a mano: las funciones nuevas del script (tipos de canal, salidas, media de los medidores) no están hasta que Cubase lo recarga.

Si Cubase va lento al cargar el script, reduce `bankSize` en la sección `CONFIG`. El script crea unas 2.900 vinculaciones con 48 canales (636 de ellas, comandos de teclado).

## Añadir tus macros y presets

1. Crea una macro o un preset del Project Logical Editor en Cubase.
2. Añádelo a `commands/user-commands.txt` con la categoría y el nombre exactos de *Editar > Comandos de teclado*:

   ```
   [Macro]
   MCP Prepare Mix Session
   ```

3. Ejecuta `npm run install:script` y recarga los scripts.

## Desarrollo

```bash
npm test   # compila, valida que el script es ES5 y ejecuta las pruebas con la simulación y ffmpeg
```

Estructura:

- `cubase-script/template/`: script de MIDI Remote (ES5). El catálogo de comandos se inyecta al compilar.
- `commands/`: catálogo de comandos de Cubase 13 y comandos de usuario.
- `src/bridge/`: protocolo SysEx y transporte MIDI.
- `src/cubase/`: cliente de alto nivel (búsqueda en unidades reales, selección de canales).
- `src/tools/`: herramientas MCP por área.
- `src/analysis/`: análisis de audio con ffmpeg.
- `src/ui/`: automatización de la interfaz en macOS.
- `test/`: simulación de la API de MIDI Remote y pruebas.
