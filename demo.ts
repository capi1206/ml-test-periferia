import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  leer_solicitud,
  mapear_campos,
  generar_formulario,
  armar_paquete,
  simular_envio
} from "./src/tools/proveedor";

async function main() {
  const rootDir = process.cwd();
  console.log("=================================================");
  console.log("   PERIFERIA IT GROUP - RETO 01 DEMO SCRIPT");
  console.log("   (Ejecución Determinística de Herramientas)");
  console.log("=================================================\n");

  // Clean out/ directory prior to execution (PRD Section 8 Requirement)
  const outDir = path.join(rootDir, "out");
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const casosDir = path.join(rootDir, "fixtures", "reto-01", "casos");
  let casofolders: string[] = [];

  try {
    const entries = await fs.readdir(casosDir, { withFileTypes: true });
    casofolders = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    console.error(`Error: No se pudo acceder a la carpeta de casos en ${casosDir}`);
    process.exit(1);
  }

  console.log(`Casos detectados (${casofolders.length}): ${casofolders.join(", ")}\n`);

  for (const caso of casofolders) {
    console.log(`-------------------------------------------------`);
    console.log(`PROCESANDO CASO: [ ${caso} ]`);
    console.log(`-------------------------------------------------`);

    const ctx = { directory: rootDir, sessionId: "demo-session" };

    // 1. Leer Solicitud
    const resLeer = JSON.parse(await leer_solicitud.execute({ caso }, ctx));
    if (!resLeer.ok) {
      console.error(`❌ [${caso}] Error al leer solicitud:`, resLeer.error);
      continue;
    }
    const { pais, cliente, formato, plantilla } = resLeer.data;
    console.log(`✓ Solicitud Leída | Cliente: ${cliente} | País: ${pais} | Formato: ${formato}`);

    // Extraer etiquetas requeridas de la plantilla
    let etiquetas: string[] = [];
    if (formato === "xlsx" && Array.isArray(plantilla)) {
      etiquetas = plantilla.map((p: any) => p.etiqueta);
    } else if (formato === "pdf" && Array.isArray(plantilla)) {
      etiquetas = plantilla.map((p: any) => p.etiqueta);
    } else {
      etiquetas = ["Razón Social", "NIT", "Dirección", "Representante Legal", "Teléfono", "Banco", "Número de Cuenta"];
    }

    // 2. Mapear Campos
    const resMapeo = JSON.parse(await mapear_campos.execute({ caso, campos: etiquetas }, ctx));
    const { llenos, faltantes, requiere_confirmacion } = resMapeo.data;
    console.log(`✓ Mapeo Completado | Llenos: ${llenos.length} | Faltantes: ${faltantes.length} | Requiere Confirmación: ${requiere_confirmacion.length}`);

    // 3. Generar Formulario
    const resForm = JSON.parse(await generar_formulario.execute({ caso, mapeo: resMapeo.data }, ctx));
    console.log(`✓ Formulario Generado: ${resForm.data.ruta}`);

    // 4. Armar Paquete para Firma
    const resPaquete = JSON.parse(await armar_paquete.execute({ caso }, ctx));
    console.log(`✓ Paquete Armado en: ${resPaquete.data.ruta}`);
    console.log(`  └─ Listo para firma: ${resPaquete.data.listo_para_firma ? "SÍ ✅" : "NO ⚠️"}`);

    // 5. Simular Envío (Prueba de guardrail sin confirmación)
    const resEnvioFallido = JSON.parse(await simular_envio.execute({ caso, confirmado: false }, ctx));
    if (!resEnvioFallido.ok) {
      console.log(`  └─ 🛡️ Guardrail verificado: Envío bloqueado correctamente sin confirmación.`);
    }

    // 6. Simular Envío Exitoso (Con confirmado: true)
    const resEnvioExitoso = JSON.parse(await simular_envio.execute({ caso, confirmado: true }, ctx));
    console.log(`✓ Envío Simulado Exitoso: ${resEnvioExitoso.data.ruta}\n`);
  }

  console.log("=================================================");
  console.log("✅ Verificación completada para todos los casos.");
  console.log("=================================================");
}

main().catch((err) => {
  console.error("Fatal error running demo.ts:", err);
  process.exit(1);
});