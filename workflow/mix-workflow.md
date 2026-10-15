# Tu flujo de mezcla

> El agente lee este archivo antes de mezclar (herramienta `cubase_get_workflow`, recurso `cubase://workflow` y prompt `mix_session`).
> Escribe aquí TU forma de trabajar. Cuanto más concreta, más se parecerá la mezcla a la tuya.
> Lo que está entre [corchetes] son ejemplos para sustituir.

## Reglas generales

- Antes de cada fase, guarda un snapshot con `cubase_snapshot_mix` (nombre: `fase-N-descripcion`).
- Nunca silencies, borres ni muevas partes de la canción: eso es decisión creativa. Pregunta.
- Justifica cada cambio con una medida (medidores, análisis de stems o comparación con la referencia).
- Al terminar cada fase, resume qué has cambiado y por qué.

## Plantilla del proyecto

- Plantilla de Cubase: [Mezcla Banda.cpr]
- Buses que ya existen en la plantilla: [DRUMS BUS, BASS BUS, GTR BUS, VOX BUS, FX REVERB PLATE, FX REVERB HALL, FX DELAY 1/4, MIX BUS]
- Cadenas cargadas y desactivadas por tipo de pista (el agente solo las activa y ajusta):
  - Bombo: [inserto 1 EQ, inserto 2 compresor, inserto 3 saturación]
  - Caja: [...]
  - Bajo: [...]
  - Guitarras: [...]
  - Voz principal: [inserto 1 de-esser, inserto 2 compresor 1, inserto 3 compresor 2, inserto 4 EQ]
  - Mix bus: [inserto 1 EQ, inserto 2 compresor de bus, inserto 3 limitador]

## Fase 1 - Organización

- Nombres de pista: [Kick In, Kick Out, Snare Top, Snare Bottom, OH L, OH R, Room, Bass DI, Bass Amp, Gtr L, Gtr R, Lead Vox, BV 1...]
- Ruteo: cada familia a su bus (drums -> DRUMS BUS...).
- Colores por familia: [drums rojo, bajo naranja, guitarras verde, voces azul, FX morado] (colorear necesita macro o Project Logical Editor).

## Fase 2 - Limpieza y ganancia

- Low cut por defecto: [voces 80 Hz, guitarras 90 Hz, overheads 150 Hz, bombo y bajo sin low cut]
- Gain staging: picos de cada pista en [-10 dBFS] con los faders a 0 dB (`cubase_gain_stage`).
- Fase: comprobar la polaridad de [Snare Bottom] y [Kick In/Out].

## Fase 3 - Balance estático

- Referencia de nivel: [la caja a -10 dB en el bus, la voz encima del resto].
- Paneo: [OH L/R al 70 %, guitarras dobladas L100/R100, bajo, bombo, caja y voz al centro].

## Fase 4 - Ecualización y dinámica

- Bombo: [punch 60-80 Hz, quitar 300-400 Hz, click 3-5 kHz; compresor ratio 4:1, ataque 10 ms].
- Bajo: [...]
- Guitarras: [...]
- Voz: [compresión en serie, 3-6 dB de reducción en total; de-esser 6-8 kHz].
- Conflictos de frecuencia: usar `audio_analyze_folder` con los stems y resolver según prioridad [voz > caja > bombo > bajo > guitarras].

## Fase 5 - Efectos

- Reverb plate para voz y caja, envío entre [-18 y -12 dB].
- Delay 1/4 para la voz en los estribillos (el agente sugiere, tú decides).

## Fase 6 - Mix bus y mastering

- Compresor de bus: [2:1, ataque 30 ms, release auto, 1-2 dB de reducción].
- Objetivo de loudness: [-14 LUFS integrado para streaming], true peak máximo [-1 dBTP].
- Referencia: [ruta absoluta a la canción de referencia].
- Comprobar con `audio_compare_to_reference` y ajustar el EQ del mix bus si alguna banda se aleja más de 1,5 dB.

## Entregables

- Exportar: [mezcla WAV 24 bit 48 kHz + master + stems por bus] en [ruta de la carpeta].
- Nombre de archivo: [Artista - Canción - Mix vN].
