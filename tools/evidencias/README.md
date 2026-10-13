# @nexo/evidencias · demostraciones registradas

Graba en video cada capacidad de Yago Nexo mientras su escenario corre de verdad contra el laboratorio, y deja
junto a cada video lo necesario para verificarlo: `<ID>_<tema>.mp4` (H.264 + AAC, 1920×1080 a 30 cps),
`.sin-musica.mp4`, `.pasos.json`, subtítulos `.vtt`, capítulos `.capitulos.vtt` e imagen de portada `.jpg`, más
`evidencias.json` y `SHA256SUMS.txt`.

| Modo | Comando | Qué hace |
|---|---|---|
| Oficial | `pnpm --filter @nexo/evidencias grabar <ids>` | Graba contra el laboratorio, desde un worktree de la etiqueta. Escribe en `release/evidencias/` y actualiza `apps/site/src/data/evidencias.json` |
| Ensayo | `pnpm --filter @nexo/evidencias grabar --ensayo <ids>` | Sin laboratorio: los guiones corren contra un servidor local que imita la Consola, Keycloak, el gateway y los portales. Todo va rotulado **ENSAYO**, `ensayo: true` en el pasos.json, salida en `release/evidencias/ensayo/`. Nunca se publica |
| Rendimiento | `pnpm --filter @nexo/evidencias grabar --rendimiento 20` | Mide la captura (cuadros distintos por segundo) con el servidor de ensayo; no toca el laboratorio |

Los ids aceptan `d04`, `D-04` o `bt8`. Se graban **en el orden en que se escriben**.

## Grabación oficial (v1.2.0)

### 0. Condiciones antes de empezar

- La etiqueta `v1.2.0` existe y su `package.json` raíz dice `1.2.0`. El rótulo de cada video dirá
  «Yago Nexo 1.2.0 · commit <etiqueta> · herramientas <HEAD>».
- VM del laboratorio con **≥ 8 GB libres** en disco (el chequeo previo aborta por debajo), nadie más usándola y
  nada compilando ni levantando contenedores mientras se graba.
- Chromium de Playwright disponible (`PLAYWRIGHT_BROWSERS_PATH`, por defecto `/opt/pw-browsers`) y
  `ffmpeg` con libx264.
- Fuentes del estudio instaladas (`fc-list | grep -ciE "liberation|dejavu"` mayor que 0): sin ellas cambian los
  cortes de línea del panel.

### 1. Worktree limpio de grabación

El worktree debe ser la etiqueta más, a lo sumo, cambios en `tools/evidencias` y `tools/aceptacion`, todo
confirmado. `grabar` lo comprueba y se niega a grabar si no se cumple.

```bash
cd ~/nexo                                    # clon del repositorio en la VM del laboratorio
git fetch origin --tags
git worktree add -b grabacion-v1.2.0 ../nexo-grabacion v1.2.0
cd ../nexo-grabacion
git checkout origin/trabajo/videos-1.2 -- tools/evidencias   # herramientas de grabación (rama publicada)
git diff --stat v1.2.0 -- tools/evidencias/package.json      # solo deben cambiar scripts, no dependencias
git commit -m "Herramientas de grabación de evidencias para v1.2.0"
pnpm install --frozen-lockfile
git status --short                                           # debe salir vacío
git diff --quiet v1.2.0 HEAD -- . ':(exclude)tools/evidencias' ':(exclude)tools/aceptacion' && echo "regla de versión: OK"
node -p "require('./package.json').version"                  # 1.2.0
```

Si `pnpm install --frozen-lockfile` falla porque cambiaron dependencias de `tools/evidencias`, no se sigue: el
lockfile de la raíz quedaría distinto de la etiqueta.

### 2. Laboratorio desde la etiqueta (05:00–06:30)

```bash
cd deploy/compose
make env           # crea .env si falta
make up            # compila y levanta el laboratorio (perfiles obs y legacy)
make bootstrap     # WSO2 y Keycloak
make legado        # plataforma heredada (APISIX y NGINX) para D-01
make continuidad   # laboratorio de dos sitios para D-05
make status
cd ../..
```

### 3. Comprobaciones rápidas (no tocan el laboratorio)

```bash
pnpm --filter @nexo/evidencias test
pnpm --filter @nexo/evidencias grabar --rendimiento 20
pnpm --filter @nexo/console-web build        # la Consola que se graba, una sola vez; después va --sin-compilar
```

Si en la prueba de rendimiento la columna p50 de 1920×1080 a 30 queda bajo 12 cuadros distintos por segundo,
agregue `--perfil 1600x900` a **todos** los comandos `grabar` de abajo (verificar acepta 1600×900 y 25 cps).
No use `--ritmo`: D-08 ya no lo necesita y el ritmo por defecto es el aprobado.

### 4. Línea base de D-02 (≈ 32 min) y D-02, encadenados

El guardián compara cada ventana de 30 s con las 60 anteriores (61 ventanas, ≈ 31 min). La línea base genera el
tráfico normal del consumidor A (OperadorDemo, 2 llamadas/s) y del consumidor B de alto volumen
(ConsumidorAltoVolumen, 25 llamadas/s; lo crea si no existe) con las reglas del guardián en pausa, y D-02 empieza
apenas termina, sin hueco en las ventanas:

```bash
pnpm --filter @nexo/evidencias exec tsx src/demos/d02-anomalias.ts --linea-base 32 \
  && pnpm --filter @nexo/evidencias grabar d02 --sin-compilar
```

`preparar()` de D-02 mide en la analítica que A y B tengan tráfico en las 60 ventanas previas y, si falta, no
graba y lo dice. Para repetir D-02 (sobre todo después de D-05) se vuelve a correr la misma línea completa.

### 5. El resto, en este orden (D-05 al final porque altera el laboratorio)

```bash
pnpm --filter @nexo/evidencias grabar bt8 d01 d03 d06 d07 d08 bt18 bt49 bt5 bt21 d04 --sin-compilar
pnpm --filter @nexo/evidencias grabar d05 --sin-compilar
```

Orden completo de la sesión: **línea base de D-02 → D-02 → BT-008 → D-01 → D-03 → D-06 → D-07 → D-08 → BT-018 →
BT-049 → BT-005 → BT-021 → D-04 → D-05**.

- Antes de cada video corre el chequeo previo (disco, memoria, CPU, ffmpeg y Chromium).
- Un video con una verificación fallida, más de 240 s, un paso de menos de 7 s o un texto no publicable no se
  guarda; `grabar` sigue con los demás y al final lista los que fallaron. Se repite solo ese:
  `pnpm --filter @nexo/evidencias grabar <id> --sin-compilar`.
- Cada video guardado actualiza `release/evidencias/evidencias.json`, `SHA256SUMS.txt` y su copia en
  `apps/site/src/data/` (estas salidas no cuentan como cambios sin confirmar).
- D-05 usa por defecto la partición por `/etc/hosts`; si no se puede editar en el agente, grabe con
  `NEXO_D05_PARTICION=agentes pnpm --filter @nexo/evidencias grabar d05 --sin-compilar` (la narración de los
  actos 1 a 3 cambia sola a esa variante).

### 6. Verificación

```bash
pnpm --filter @nexo/evidencias verificar              # 15 criterios por video, también contra la copia del sitio
# con respaldos del formato anterior (WebM) aún en el índice:
pnpm --filter @nexo/evidencias verificar -- --permitir-anteriores

cd release/evidencias
sha256sum -c SHA256SUMS.txt
# la música no tocó la imagen: el MD5 del flujo de video es igual con y sin música
for f in *.mp4; do
  case "$f" in *.sin-musica.mp4) continue ;; esac
  b="${f%.mp4}"
  con=$(ffmpeg -v error -i "$f" -map 0:v -c copy -f md5 -)
  sin=$(ffmpeg -v error -i "$b.sin-musica.mp4" -map 0:v -c copy -f md5 -)
  [ "$con" = "$sin" ] && echo "OK  $b  $con" || echo "DISTINTO  $b  $con / $sin"
  sha256sum "$f" "$b.sin-musica.mp4"
done
cd ../..
```

Revisión de 10 fotogramas por video (cursor, panel, ampliación, rótulos, portada y cierre; que no aparezca
ENSAYO):

```bash
mkdir -p /tmp/fotogramas
for f in release/evidencias/*.mp4; do
  case "$f" in *.sin-musica.mp4) continue ;; esac
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
  for i in 0 1 2 3 4 5 6 7 8 9; do
    t=$(awk -v d="$d" -v i="$i" 'BEGIN { printf "%.2f", d * (i + 0.5) / 10 }')
    ffmpeg -v error -y -ss "$t" -i "$f" -frames:v 1 "/tmp/fotogramas/$(basename "${f%.mp4}")-$i.png"
  done
done
```

La vista previa local (`tools/evidencias/vista-previa.html`, en Chrome, Edge, Firefox o Safari) muestra cada
video con sus subtítulos, capítulos y verificaciones; se elige la carpeta `release/evidencias`.

### 7. Actualizar evidencias.json y publicar

1. `grabar` ya dejó `apps/site/src/data/evidencias.json` y `apps/site/src/data/SHA256SUMS.txt` al día en el
   worktree de grabación. Cópielos a la rama del sitio y confírmelos allí:
   ```bash
   cp apps/site/src/data/evidencias.json apps/site/src/data/SHA256SUMS.txt <clon-del-sitio>/apps/site/src/data/
   ```
2. El build del sitio copia los videos desde `release/evidencias/` (copiar-evidencias.mjs: rechaza ensayos,
   SHA-256 distintos y textos no publicables), así que esa carpeta debe estar en la máquina que compila el sitio:
   ```bash
   pnpm --filter @nexo/site build
   ```
3. Después de publicar, descargue los videos del sitio y corra `sha256sum -c SHA256SUMS.txt` sobre lo descargado.

Si una toma no queda bien, se conserva el video anterior con su SHA-256 (salvo BT-008, que no se cita) y
`verificar -- --permitir-anteriores` lo revisa como respaldo.

## Ensayo (iterar sin laboratorio)

```bash
pnpm --filter @nexo/evidencias grabar --ensayo d04 d06 bt8 --salida /tmp/ensayo
pnpm --filter @nexo/evidencias verificar -- --dir /tmp/ensayo --sin-sitio   # debe fallar solo «no es ensayo»
pnpm --filter @nexo/evidencias grabar --ensayo motor                      # guion propio del motor
```

El ensayo escribe en su carpeta un `evidencias.json` de ensayo (cada entrada con `rehearsal: true`) para poder
correr `verificar` sobre él; nunca escribe en `release/evidencias` ni en el sitio. Cada toma de unos 2 min usa
1 a 2 GB de cuadros temporales en `TMPDIR` mientras graba.

## Música

Música original generada por código (síntesis determinista, estilo «ambiental cálido», 3 variantes, −18 LUFS).
`pnpm --filter @nexo/evidencias musica` regenera las muestras de `musica/`; para cambiar la variante de un video
ya grabado sin regrabarlo ni tocar su imagen:

```bash
pnpm --filter @nexo/evidencias remezclar D-01 --variante 2
```

## Variables de entorno

| Variable | Uso |
|---|---|
| `PLAYWRIGHT_BROWSERS_PATH` | Carpeta de Chromium (por defecto `/opt/pw-browsers`) |
| `TMPDIR` | Cuadros temporales de la captura (1 a 2 GB por video de 2 min) |
| `NEXO_D05_PARTICION=agentes` | Variante de respaldo de la partición de D-05 |
| `EVIDENCIAS_PRESET` | Preset de x264 (por defecto `medium`) |
| `EVIDENCIAS_CRF` | Calidad de x264, 18–26 (por defecto 21, ≈ 1,4 Mb/s con audio; 22 baja la tasa ~10 % más) |
| `EVIDENCIAS_NTH`, `EVIDENCIAS_Q_OPERADO`, `EVIDENCIAS_Q_NARRADOR` | Captura: cada cuántos cuadros y calidad JPEG |
| `EVIDENCIAS_PROHIBIDOS`, `EVIDENCIAS_PROHIBIDOS_HUELLAS` | Términos extra que la vigilancia de textos no publicables detiene |
| `EVIDENCIAS_DEPURACION=<carpeta>` | Captura de la pantalla operada si un guion falla |
| `EVIDENCIAS_PUERTO_ENSAYO` | Puerto del servidor de ensayo (por defecto 5174), para dos ensayos a la vez |

## Pruebas

```bash
pnpm --filter @nexo/evidencias typecheck
pnpm --filter @nexo/evidencias lint
pnpm --filter @nexo/evidencias test
```
