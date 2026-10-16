# Documentación Técnica: Solución Agente Conversacional "Registro como Proveedor"

**Empresa:** Periferia IT Group  
**Proyecto:** Reto 01 — Agente Conversacional 'Registro como Proveedor'  
**Tecnologías:** TypeScript (Node.js 20+), Express.js, OpenAI API (`gpt-4o` / `gpt-4o-mini`), Zod, CSS3/HTML5 Frontend  

---

## 1. Arquitectura y Ciclo de Ejecución del Agente

La solución implementa una arquitectura desacoplada basada en el patrón de **Llamada a Herramientas Reentrante (Tool-Calling Loop)** con validación estricta mediante schemas de Zod.

```
 [ Usuario (UI Web / API) ]
            │
            ▼
┌───────────────────────────┐
│   Backend Express (Server)│
└───────────┬───────────────┘
            │ 1. Envía prompt de sistema + historial
            ▼
┌───────────────────────────┐
│   OpenAI GPT-4o / Mini    │
└───────────┬───────────────┘
            │ 2. Retorna tool_calls (JSON)
            ▼
┌───────────────────────────┐
│  Módulo Tools (Zod / TS)  │ ◄─── Ejecuta fs / lectura / mapeo / out
└───────────┬───────────────┘
            │ 3. Retorna resultado de la herramienta
            ▼
┌───────────────────────────┐
│ Re-evaluación del Agente  │ ─── (Hasta maxIterations = 10)
└───────────┬───────────────┘
            │ 4. Respuesta Final + Metadata
            ▼
 [ Usuario (UI Web / API) ]
```

### Componentes Clave:
* **`agent/prompt.md`**: Define las reglas del sistema, incluyendo cero alucinaciones, transparencia en la corrección de nombres de caso y restricción de confirmación humana previa para simulación de envíos.
* **`src/tools/proveedor.ts`**: Colección de herramientas fuertemente tipadas:
  * `proveedor_leer_solicitud`: Normalización difusa (*fuzzy matching*) de carpetas de caso y extracción de plantillas/soportes exigidos.
  * `proveedor_mapear_campos`: Cruce entre la solicitud del cliente, el glosario de sinónimos (`glosario-campos.json`) y el repositorio maestro.
  * `proveedor_generar_formulario`: Generación de entregables llenos en el directorio `out/`.
  * `proveedor_armar_paquete`: Consolidación y validación de vigencias de soportes documentales (RUT, Cámara de Comercio, etc.).
  * `proveedor_simular_envio`: Validación final y simulación de envío al portal/cliente.
* **`src/server.ts`**: Servidor Express con persistencia de sesiones en memoria, manejo estático del frontend y servidor API REST (`/api/chat`, `/api/health`, `/api/sessions/:id`).
* **`web/index.html`**: Interfaz de chat estática con visor interactivo de llamadas a herramientas (*tool call inspection*).

---

## 2. Capacidades Principales Implementadas

1. **Auto-Corrección Transparente de Nombres de Carpetas:**
   * Algoritmo de normalización que tolera errores tipográficos, guiones faltantes o variaciones de capitalización (e.g., mapea `ec-corpandina` $\rightarrow$ `ec-corp-andina`).
   * Retorna metadatos `fueCorregido: true` y `casoOriginal` para que el agente notifique explícitamente al usuario.
2. **Sugerencia Inteligente de Casos:**
   * Si la carpeta no coincide incluso tras la normalización, el sistema retorna una lista explícita de casos disponibles para orientar al usuario.
3. **Flujo Cero Alucinaciones:**
   * La información de los campos proviene estrictamente del archivo `repositorio.json` y del glosario de términos.
4. **Validación de Vigencias de Documentación:**
   * Detección de soportes vencidos o ausentes según la matriz de vigencias del repositorio maestro.
5. **Human-in-the-Loop Guardrail:**
   * La herramienta `proveedor_simular_envio` requiere confirmación explícita del usuario en el mensaje inmediatamente anterior para evitar transmisiones accidentales.

---

## 3. Cobertura de las Pruebas Actuales

### Lo que SÍ cubren las pruebas actualizadas:
* **Prueba Determinista (`demo.ts`):** Ejecución secuencial sin costo de tokens para los 4 casos oficiales (`co-industrias-delta`, `ec-corp-andina`, `hn-agroexport-sula`, `pa-logistica-istmo`).
* **Verificación de Mapeo de Campos:** Mapeo correcto de etiquetas heterogéneas (sinónimos en español/inglés) hacia las claves maestras.
* **Manejo de Formatos Heterogéneos:** Lectura y llenado simulado para archivos tipo Excel (`xlsx`), PDF o Formularios Web (`portal`).
* **Respuesta Frente a Inconsistencias:** Detección de campos obligatorios faltantes o documentos con fecha vencida.

---

## 4. Aspectos NO Cubiertos en la Suite de Pruebas Actual

* **Escenarios Concurrenciales Multi-Usuario:** Las sesiones se mantienen en un `Map` en memoria sin bloqueo de concurrencia o aislamiento a nivel de base de datos.
* **Archivos Binarios Reales (PDF/XLSX Parsing):** Los casos leen abstracciones estructuradas en `json` (`plantilla-celdas.json` / `plantilla-campos.json`). No se ejecuta un OCR o parser binario nativo sobre archivos PDF/Excel físicos.
* **Conexión HTTP Real con Servicios Externos:** La herramienta `proveedor_simular_envio` simula el éxito de entrega registrando logs en disco; no realiza llamadas Webhook/REST reales a portales de terceros.

---

## 5. Debilidades Actuales de la Implementación

1. **Persistencia Volátil:** El almacén de sesiones se reinicia al detener el proceso Node.js.
2. **Límite de Contexto e Iteraciones:** Aunque existe un límite seguro (`maxIterations = 10`), diálogos extremadamente largos sin limpieza de historial pueden consumir presupuesto de tokens innecesario.
3. **Mapeo de Términos Basado en Reglas Fijas:** El mapeo depende exclusivamente de las llaves en `glosario-campos.json`. Términos no contemplados en el glosario no se resuelven mediante embeddings / búsqueda semántica.

---

## 6. Oportunidades de Mejora para Entornos de Producción

1. **Implementación de Búsqueda Semántica (RAG / Vector DB):**
   * Integrar una base de datos vectorial (como ChromaDB o PGVector) para encontrar equivalencias de campos en el glosario cuando la coincidencia exacta de texto falle.
2. **Persistencia de Sesiones en Base de Datos:**
   * Reemplazar la estructura en memoria por PostgreSQL o Redis con TTL para soportar balanceo de carga entre múltiples réplicas del servidor.
3. **Estimación y Control de Costos por Token:**
   * Implementar `gpt-4o-mini` por defecto para tareas mecánicas de extracción/mapeo, utilizando `gpt-4o` únicamente para razonamientos complejos o generación final.
4. **Observabilidad y Rastreabilidad (LLM Telemetry):**
   * Integrar herramientas como LangSmith, OpenTelemetry o Helicone para medir latencia, ratio de éxito de herramientas y costo exacto por transacción.

## 7. Despliegue y Exposición Pública (Arquitectura Ngrok)

Para la sesión de defensa técnica y evaluación en vivo, se implementó una estrategia de despliegue mediante un túnel seguro **Ngrok**.