# PDF Splitter por Razón Social

Una herramienta web portable para separar las páginas de un PDF por empresa.
Se ejecuta directamente en tu navegador: **sin instalación, servidor ni conexión
a Internet**. Los documentos se procesan en memoria dentro de tu ordenador.

## Uso

1. Descarga y descomprime la carpeta del proyecto.
2. Abre **`index.html`** con doble clic en un navegador de escritorio actual.
3. Arrastra un PDF o pulsa **Seleccionar PDF**.
4. Revisa las empresas y el número de páginas detectadas.
5. Descarga un documento individual o pulsa **Descargar ZIP**.

Si hay páginas sin razón social o con valores contradictorios, la aplicación
mostrará sus números. Pulsa **Descargar igualmente** para incluirlas en
`SIN_RAZON_SOCIAL.pdf` y habilitar las descargas. Todas las páginas del original
quedan incluidas en el ZIP, una sola vez y manteniendo su orden dentro de cada
documento.

**Procesar otro PDF** libera el documento anterior y permite seleccionar otro
archivo, incluido el mismo archivo de nuevo.

## Qué PDFs admite

El MVP lee la razón social de **campos de texto AcroForm**, inicialmente llamados
`razonSocial`. También admite campos jerárquicos como:

```text
solicitud1.razonSocial → EMPRESA A SL
solicitud2.razonSocial → EMPRESA B SL
solicitud3.razonSocial → EMPRESA A SL
```

Los campos de un PDF pertenecen al documento, no a cada página. Un único campo
con varias apariciones comparte el mismo valor en todas ellas. Para representar
empresas distintas deben existir campos independientes; el programa localiza
las apariciones de cada campo en las páginas.

- Agrupa empresas aunque sus páginas no sean consecutivas.
- Normaliza espacios, Unicode equivalente y mayúsculas; conserva los acentos.
- No deduce la empresa de una página a partir de la página anterior.
- Un campo coincidente vacío junto a otro relleno se considera ambiguo.
- Los formularios **XFA**, PDFs cifrados y estructuras dañadas tienen mensajes de
  incompatibilidad. Los PDFs sin campos se presentan como páginas sin razón social.
- No realiza OCR ni extrae la razón social del texto impreso o de imágenes.

Los PDFs generados tienen **contenido fijo**: las apariencias del formulario
pasan a formar parte de las páginas y los campos dejan de ser editables. Se
conservan las apariencias existentes. Las ausentes se reconstruyen únicamente
cuando su tipo y sus caracteres permiten hacerlo correctamente; en caso
contrario se muestra un error en lugar de generar contenido incompleto.

## Configurar el campo

En la parte superior de `app.js`:

```js
const CONFIG = { companyField: 'razonSocial' };
const DEBUG = false;
```

Puedes cambiar `companyField` por `razon_social`, `companyName`, `businessName`,
`empresa` u otro nombre real del formulario. Un nombre simple coincide con el
componente final de los campos jerárquicos. Un nombre con puntos, como
`solicitud1.companyName`, selecciona ese nombre completo. La comparación de
nombres de campos tolera mayúsculas, acentos, espacios y guiones bajos.

Con `DEBUG = true`, la consola del navegador muestra los nombres de los campos
disponibles, sin sus valores. Por defecto solo se registran códigos técnicos de
error, sin contenido del documento.

## Privacidad y funcionamiento offline

- Bibliotecas, estilos e iconos están incluidos en la carpeta.
- No hay llamadas de red, CDN, analítica ni telemetría.
- La política del HTML bloquea conexiones externas (`connect-src 'none'`).
- No se utilizan cookies, almacenamiento local, base de datos ni historial.
- Solo las descargas que solicites se guardan como archivos.

Mantén `index.html`, `styles.css`, `app.js` y las carpetas `lib`, `services` y
`utils` juntas. No necesitas Node.js ni ejecutar comandos para usar la aplicación.

## Estructura

```text
index.html / styles.css / app.js    Interfaz y estados
services/pdf-reader.js             Validación y apertura del PDF
services/field-extractor.js        Campos, páginas y agrupación
services/pdf-splitter.js           Contenido fijo y documentos resultantes
services/zip-generator.js          ZIP en memoria
utils/filename.js                 Nombres seguros y únicos
utils/validation.js               Validación, errores y pausas de procesamiento
lib/                              Bibliotecas locales y licencias
tests/                            Pruebas y PDFs sintéticos en memoria
PRODUCT.md                        Especificación funcional del producto
```

Scripts clásicos con `defer`, compatibles con `file://`; no hay compilación ni
framework de interfaz. Dependencias de ejecución: **pdf-lib 1.17.1** y
**JSZip 3.10.2**. Su procedencia y licencias están en `lib/LICENSES.txt`.

Los documentos se generan secuencialmente y se reutilizan en descargas posteriores.
La copia por lotes comparte recursos como imágenes y fuentes dentro de cada PDF.
El ZIP utiliza `STORE`: muchos recursos PDF ya están comprimidos, y así se evita
trabajo de compresión adicional. El documento original, los PDFs generados y el
ZIP ocupan memoria mientras están abiertos; la capacidad depende del navegador y
del equipo. El procesamiento habitual de cientos de páginas ofrece progreso y
pausas para actualizar la interfaz.

## Desarrollo y pruebas

Solo para desarrollo, con Node.js 22 o posterior:

```sh
npm test
```

No requiere instalar paquetes. Las pruebas utilizan las bibliotecas incluidas y
generan PDFs sintéticos en memoria. Comprueban agrupación, apariencias, nombres,
errores, orden de páginas y la reapertura de los PDFs y del ZIP.

La prueba de navegador real está en `tests/browser-smoke.cjs`. Su instalación de
herramientas temporal y ejecución se explican en
[`tests/browser-README.md`](tests/browser-README.md). Abre `index.html` mediante
`file://` con el navegador offline y comprueba descargas reales, arrastre,
teclado, diseño responsive, ausencia de red y documentos de 300 páginas.

Verificación inicial: 31 pruebas de servicios y 16 escenarios de navegador
superados en Node.js 22.22.3 y Chromium 153.0.8010.12. Los documentos iniciales de
prueba son sintéticos; la validación con PDFs reales se realizará cuando estén
disponibles.
