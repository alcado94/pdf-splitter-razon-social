# PDF Splitter por Razón Social

## 1. Nombre provisional

Aplicación web local y portable para fragmentar un PDF en documentos independientes
según la razón social detectada en sus páginas. Puede abrirse mediante `index.html`
sin instalación ni servidor, o instalarse como PWA desde GitHub Pages. No requiere
backend ni Internet para procesar documentos.

## 2. Objetivo del producto

Seleccionar o arrastrar un PDF, analizar todas sus páginas, identificar empresas,
agrupar sus páginas, crear un PDF por empresa y descargar los resultados.
Todo el procesamiento se realiza en el navegador; ningún documento se envía a
servidores externos.

## 3. Principios

Simplicidad, privacidad, portabilidad, funcionamiento offline, instalación
opcional, cero configuración para el uso habitual, interfaz mínima y código
mantenible. La distribución es una carpeta con HTML, CSS, JavaScript y
bibliotecas locales.

## 4. Usuario objetivo

Usuarios administrativos o de negocio que reciben solicitudes o formularios
agrupados en un PDF. Por ejemplo:

```text
Página 1 → EMPRESA A SL
Página 2 → EMPRESA A SL
Página 3 → EMPRESA B SL
Página 4 → EMPRESA C SL
Página 5 → EMPRESA C SL
Página 6 → EMPRESA C SL
```

Resultado: `EMPRESA_A_SL.pdf`, `EMPRESA_B_SL.pdf` y `EMPRESA_C_SL.pdf`.

## 5. Selección del PDF

Zona de arrastre y botón **Seleccionar PDF**. Se permite un único archivo por
proceso; los archivos múltiples, vacíos o no válidos se rechazan con un mensaje
comprensible. La selección debe ser accesible mediante teclado.

## 6. Análisis del documento

Obtener número total de páginas, existencia de formularios, campos disponibles
y valores de razón social. El MVP utiliza campos estructurados de texto AcroForm.
Los nombres de campos pueden configurarse posteriormente.

## 7. Extracción de razón social

Campo inicial: `razonSocial`. Normalizar espacios, Unicode equivalente y mayúsculas.
Relacionar cada valor con las páginas donde aparecen sus widgets.

Un formulario AcroForm pertenece al documento completo: un campo con múltiples
widgets comparte un valor. Empresas diferentes requieren campos independientes,
por ejemplo `solicitud1.razonSocial` y `solicitud2.razonSocial`. Deben admitirse
esas jerarquías y la localización alternativa mediante anotaciones cuando falte
la referencia directa de página.

Modelo conceptual, con índices de página desde cero:

```js
{
  'EMPRESA A SL': [0, 1],
  'EMPRESA B SL': [2],
  'EMPRESA C SL': [3, 4, 5]
}
```

## 8. Agrupación de páginas

Las páginas no tienen que ser consecutivas. Si las páginas 1, 2 y 4 pertenecen a
la misma empresa, se reúnen en un documento y mantienen ese orden. No se asigna
automáticamente una empresa a una página sin campo por proximidad.

## 9. Generación de PDFs

Crear un documento independiente por empresa mediante pdf-lib. Conservar el
contenido y el orden original. Para el MVP acordado, los campos se convierten
en contenido fijo antes de copiar las páginas: mantienen su aspecto, pero dejan
de ser editables. Las apariencias ausentes solo se reconstruyen si es posible
conservar el contenido correctamente.

## 10. Nombres de documentos

Derivarlos de la razón social. Convertir espacios en guiones bajos, retirar
caracteres problemáticos y puntos innecesarios, evitar nombres vacíos o reservados
y limitar la longitud. Resolver colisiones con sufijos sin sobrescribir archivos.
Ejemplo: `Empresa Ejemplo S.L.` → `Empresa_Ejemplo_SL.pdf`.

## 11. Descargas del MVP

Listado de empresas y número de páginas con una descarga individual por grupo.
**Descargar ZIP** equivale a descargar todos los documentos en una sola acción.

## 12. ZIP

JSZip genera `documentos_fragmentados.zip` en memoria, con un PDF por razón social
y, cuando corresponda, el grupo de páginas no identificadas.

## 13. Interfaz

Limpia, moderna, minimalista, con espacio en blanco, tipografía del sistema,
bordes suaves, diseño responsive y feedback claro. No debe parecer un sistema
empresarial complejo.

## 14. Pantalla inicial

Nombre del producto, descripción breve, zona de arrastre, botón de selección y
mensaje **Los archivos nunca salen de tu ordenador**.

## 15. Pantalla de análisis

Nombre del archivo, número de páginas, etapa actual, progreso y páginas analizadas.
El progreso debe actualizarse periódicamente durante el procesamiento; la lectura
inicial puede mostrarse como una operación de duración indeterminada.

## 16. Pantalla de resultado

Resumen de páginas y documentos, listado por razón social con número de páginas,
descargas individuales, **Descargar ZIP** y **Procesar otro PDF**.

## 17. Errores

Mensajes comprensibles, sin mostrar directamente excepciones de JavaScript o de
las bibliotecas. Registrar códigos técnicos de diagnóstico localmente.

## 18. Fichero inválido

Explicar que no se ha podido abrir el archivo y pedir un PDF válido. Distinguir,
cuando sea posible, archivos vacíos, dañados y protegidos con contraseña.

## 19. Razón social no encontrada

Mostrar la cantidad de páginas no identificadas y sus números, desde uno.
El usuario podrá pulsar **Descargar igualmente** para incluirlas en
`SIN_RAZON_SOCIAL.pdf`. Los valores contradictorios en una página se presentan
para revisión dentro de este grupo. Ninguna página debe descartarse silenciosamente.

## 20. PDF no compatible

Explicar las estructuras no soportadas, como XFA, con un mensaje de usuario y
un motivo técnico interno. Detectar XFA antes de acceder al formulario mediante
`getForm()`, que elimina esos datos en pdf-lib.

## 21. Privacidad

PDF original, campos, razones sociales y documentos generados permanecen en memoria.
Sin peticiones de la app a APIs externas, telemetría, analítica ni almacenamiento
persistente de documentos. La PWA solo almacena recursos estáticos en CacheStorage.

## 22. Offline

Todas las dependencias están incluidas localmente. Sin scripts CDN ni fuentes
externas. Debe funcionar mediante `file://` y, después de la primera visita
HTTPS, como PWA instalada sin conexión.

## 23. Stack

HTML5, CSS3 y JavaScript. Sin framework de interfaz ni compilación obligatoria.

## 24. Procesamiento PDF

pdf-lib: abrir PDFs, leer formularios, localizar valores, conservar apariencias,
copiar páginas, crear documentos y guardarlos.

## 25. Generación de ZIP

JSZip: reunir PDFs y generar el archivo descargable en el navegador.

## 26. Descargas

Utilizar `Blob`, `URL.createObjectURL()` y un enlace de descarga. Liberar las
URLs temporales cuando ya no se necesiten y al cambiar de documento.

## 27. Arquitectura

```text
index.html
styles.css
app.js
manifest.webmanifest
sw.js
icons/
services/
  pdf-reader.js
  field-extractor.js
  pdf-splitter.js
  zip-generator.js
utils/
  filename.js
  validation.js
lib/
  pdf-lib.min.js
  jszip.min.js
```

## 28. Responsabilidades

- `app.js`: interfaz, eventos, arrastre, estados, progreso y resultados.
- `pdf-reader.js`: validación, apertura y compatibilidad del documento.
- `field-extractor.js`: nombres de campos, valores y asociación a las páginas.
- `pdf-splitter.js`: contenido fijo, copia de páginas y PDFs independientes.
- `zip-generator.js`: ZIP a partir de los PDFs generados.
- `filename.js`: nombres seguros y únicos.
- `validation.js`: selección, errores de usuario y pausas cooperativas.

## 29. Modelo de datos

Estado temporal con nombre de archivo, número de páginas, grupos de empresas,
páginas no identificadas, estado de proceso y resultados generados reutilizables.
Se recomienda `Map` para los grupos para admitir cualquier razón social sin
colisiones con propiedades de objetos. No se necesita base de datos.

## 30. Estados

`idle` → `loading` → `analyzing` → `processed` → `generating` → `completed`.
Cualquier etapa puede pasar a `error`. Las operaciones concurrentes y las
descargas duplicadas deben impedirse mientras una operación esté en curso.

## 31. Rendimiento

Priorizar documentos habituales de cientos de páginas. Los tamaños previstos
pueden ir de 10 a 200 MB; no se exige soporte para varios GB. Evitar copias de
bytes y recursos innecesarias, generar secuencialmente y liberar referencias
al iniciar otro proceso. El límite práctico depende del navegador y del equipo.

## 32. Progreso

Mostrar etapa, contador y porcentaje de operaciones medibles. Ceder tiempo al
navegador en lotes para que pueda actualizar la interfaz. No simular progreso
con temporizadores que no representen trabajo real.

## 33. Web Workers

No son obligatorios inicialmente. Si las pruebas con documentos grandes muestran
bloqueos visuales, trasladar el procesamiento pesado a un worker compatible con
la distribución portable. Las operaciones síncronas de una sola página o campo
excepcionalmente grande pueden necesitar esta evolución.

## 34. Configuración del campo

```js
const CONFIG = { companyField: 'razonSocial' };
```

Otros nombres posibles: `razon_social`, `businessName`, `companyName`, `empresa`
y `nombreEmpresa`. Una interfaz de configuración queda para una fase posterior.

## 35. Auto-detección futura

En una versión posterior, detectar candidatos como `razonsocial`, `razon_social`,
`empresa`, `company`, `companyname` y `businessname` entre los campos existentes.

## 36. Debug

`DEBUG` permitirá listar campos disponibles en la consola de desarrollo. Esa
información no aparecerá en la interfaz habitual ni incluirá valores de campos.

## 37. MVP

Selección, arrastre, lectura, identificación de razón social, agrupación, generación
de PDFs, listado de empresas, descarga individual y ZIP, procesamiento local y
funcionamiento offline e instalación opcional desde HTTPS.

## 38. Fuera del MVP

OCR, inteligencia artificial, backend, login, usuarios, base de datos, historial,
API, sincronización, cloud, Electron y aplicación móvil.

## 39. Fases posteriores

- V2: detección automática de campos.
- V3: previsualización visual de páginas.
- V4: reglas de fragmentación por razón social, NIF, expediente u otro campo.
- V5: documentos sin formulario mediante extracción de texto con PDF.js.
- V6: OCR opcional para documentos escaneados.

## 40. Evolución del producto

Posible motor genérico configurable por razón social, CIF/NIF, número de expediente,
número de solicitud o campo personalizado.

## 41. Filosofía técnica

Antes de añadir una dependencia: **¿Es realmente necesaria para resolver el
problema?** Una herramienta pequeña que identifica empresas, agrupa páginas,
crea documentos y los descarga.

## 42. Criterios de éxito

Un usuario no técnico puede abrir `index.html` o instalar la app desde su URL
HTTPS, arrastrar un PDF, pulsar un botón, recibir un ZIP y abrir correctamente
los PDFs. No necesita terminal ni configurar Node.js/Python para utilizarla.

La verificación incluye PDFs sintéticos mientras no haya un ejemplo real
anonimizado disponible, reapertura de resultados y pruebas de navegador offline.

## 43. Experiencia deseada

**DOBLE CLIC → ARRASTRAR PDF → FRAGMENTAR → DESCARGAR ZIP**.
El usuario no necesita conocer la estructura interna de los documentos PDF.
