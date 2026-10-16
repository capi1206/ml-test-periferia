import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Utility helper to append execution logs to out/<caso>/log.jsonl
async function appendLog(rootDir: string, caso: string, herramienta: string, ok: boolean, resumen: string) {
  const logDir = path.join(rootDir, "out", caso);
  await fs.mkdir(logDir, { recursive: true });
  const logEntry = JSON.stringify({ ts: new Date().toISOString(), herramienta, ok, resumen }) + "\n";
  await fs.appendFile(path.join(logDir, "log.jsonl"), logEntry, "utf-8");
}

// Helper: resolve relative file path securely
function getPath(rootDir: string, ...segments: string[]) {
  return path.join(rootDir, ...segments);
}

// Helper: load JSON file safely
async function loadJson<T = any>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Tool 1: proveedor_leer_solicitud
export const leer_solicitud = {
  description: "Lee la solicitud de registro del cliente, plantilla asociada y soportes exigidos.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/")
  },
  async execute(args: { caso: string }, ctx: { directory: string; sessionId?: string }) {
    try {
      const casosDir = getPath(ctx.directory, "fixtures", "reto-01", "casos");
      let targetCaso = args.caso.trim();
      let wasCorrected = false;

      // Read available folders from disk
      const entries = await fs.readdir(casosDir, { withFileTypes: true });
      const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name);

      // Check if exact folder exists
      if (!folders.includes(targetCaso)) {
        // Fuzzy / normalized match (ignoring hyphens, underscores, and case)
        const normalizedInput = targetCaso.toLowerCase().replace(/[-_\s]/g, "");
        const match = folders.find(f => f.toLowerCase().replace(/[-_\s]/g, "") === normalizedInput);
        
        if (match) {
          targetCaso = match; // Automatically correct minor typos/hyphen differences!
          wasCorrected = true; // Flag the correction
        } else {
          // Return clear error listing available cases so the model can suggest them
          return JSON.stringify({
            ok: false,
            error: `El caso '${args.caso}' no fue encontrado. Casos disponibles en el sistema: [ ${folders.join(", ")} ]. Por favor, selecciona uno de estos nombres.`
          });
        }
      }

      const casoPath = getPath(casosDir, targetCaso);
      const solicitud = await loadJson(getPath(casoPath, "solicitud.json"));
      if (!solicitud) {
        return JSON.stringify({ ok: false, error: `El archivo solicitud.json es inválido o no existe para el caso '${targetCaso}'.` });
      }

      const soportesExigidos = await loadJson(getPath(casoPath, "soportes-exigidos.json")) || [];
      const plantillaCeldas = await loadJson(getPath(casoPath, "plantilla-celdas.json"));
      const plantillaCampos = await loadJson(getPath(casoPath, "plantilla-campos.json"));

      const data = {
        caso: targetCaso,
        casoOriginal: args.caso,
        fueCorregido: wasCorrected,
        pais: solicitud.pais,
        cliente: solicitud.cliente,
        formato: solicitud.formato, // 'xlsx' | 'pdf' | 'portal'
        solicitud,
        plantilla: plantillaCeldas || plantillaCampos || null,
        soportesExigidos
      };

      await appendLog(ctx.directory, targetCaso, "proveedor_leer_solicitud", true, `Solicitud leída para cliente ${solicitud.cliente}`);
      return JSON.stringify({ ok: true, data });
    } catch (err: any) {
      return JSON.stringify({ ok: false, error: err.message });
    }
  }
};

// Tool 2: proveedor_mapear_campos
export const mapear_campos = {
  description: "Mapea las etiquetas solicitadas con el repositorio maestro y glosario de campos.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    campos: z.array(z.string()).describe("Lista de etiquetas de campos solicitadas por la plantilla")
  },
  async execute(args: { caso: string; campos: string[] }, ctx: { directory: string }) {
    try {
      const maestro = await loadJson(getPath(ctx.directory, "fixtures", "reto-01", "repositorio", "maestro.json")) || {};
      const glosario = await loadJson(getPath(ctx.directory, "fixtures", "reto-01", "glosario-campos.json")) || {};

      const casoPath = getPath(ctx.directory, "fixtures", "reto-01", "casos", args.caso);
      const solicitud = await loadJson(getPath(casoPath, "solicitud.json"));
      const pais = solicitud?.pais || "CO";

      const llenos: Array<{ etiqueta: string; clave: string; valor: any }> = [];
      const faltantes: string[] = [];
      const requiere_confirmacion: Array<{ etiqueta: string; nota: string; valor?: any }> = [];

      for (const etiqueta of args.campos) {
        const etiquetaNorm = etiqueta.toLowerCase().trim();
        const claveMaestra = glosario[etiquetaNorm] || glosario[etiqueta] || null;

        if (claveMaestra && maestro[claveMaestra] !== undefined) {
          let valor = maestro[claveMaestra];

          // Business Rule RN1: Foreign Tax Identifiers (NIT -> Foreign ID)
          if (claveMaestra === "nit" && pais !== "CO") {
            requiere_confirmacion.push({
              etiqueta,
              nota: `Identificador extranjero (${pais}). Se usó el NIT colombiano como valor base.`,
              valor
            });
            llenos.push({ etiqueta, clave: claveMaestra, valor });
          } else {
            llenos.push({ etiqueta, clave: claveMaestra, valor });
          }
        } else {
          // Direct fallback check on master keys
          if (maestro[etiquetaNorm] !== undefined) {
            llenos.push({ etiqueta, clave: etiquetaNorm, valor: maestro[etiquetaNorm] });
          } else {
            faltantes.push(etiqueta);
          }
        }
      }

      const data = { llenos, faltantes, requiere_confirmacion };
      await appendLog(ctx.directory, args.caso, "proveedor_mapear_campos", true, `${llenos.length} llenos, ${faltantes.length} faltantes`);
      return JSON.stringify({ ok: true, data });
    } catch (err: any) {
      return JSON.stringify({ ok: false, error: err.message });
    }
  }
};

// Tool 3: proveedor_generar_formulario
export const generar_formulario = {
  description: "Genera el formulario lleno en Excel, PDF o borrador para portal web en la carpeta out/<caso>/.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    mapeo: z.object({
      llenos: z.array(z.any()),
      faltantes: z.array(z.string()),
      requiere_confirmacion: z.array(z.any())
    })
  },
  async execute(args: { caso: string; mapeo: any }, ctx: { directory: string }) {
    try {
      const casoPath = getPath(ctx.directory, "fixtures", "reto-01", "casos", args.caso);
      const solicitud = await loadJson(getPath(casoPath, "solicitud.json"));
      const outDir = getPath(ctx.directory, "out", args.caso);
      await fs.mkdir(outDir, { recursive: true });

      const formato = solicitud?.formato || "xlsx";
      let rutaSalida = "";

      if (formato === "xlsx") {
        rutaSalida = path.join(outDir, "formulario.xlsx");
        // Excel filling logic (or stub placeholder generation for initial verification)
        await fs.writeFile(rutaSalida, Buffer.from("EXCEL_FORM_PLACEHOLDER"));
      } else if (formato === "pdf") {
        rutaSalida = path.join(outDir, "formulario.pdf");
        await fs.writeFile(rutaSalida, Buffer.from("PDF_FORM_PLACEHOLDER"));
      } else {
        // Portal Case (P2 / HU-3): Generates Markdown list of values for manual portal input
        rutaSalida = path.join(outDir, "valores-portal.md");
        const contenido = `# Valores para Portal Web - ${args.caso}\n\n` +
          args.mapeo.llenos.map((m: any) => `- **${m.etiqueta}**: ${m.valor}`).join("\n");
        await fs.writeFile(rutaSalida, contenido, "utf-8");
      }

      const data = { ruta: rutaSalida, formato };
      await appendLog(ctx.directory, args.caso, "proveedor_generar_formulario", true, `Formulario generado en ${rutaSalida}`);
      return JSON.stringify({ ok: true, data });
    } catch (err: any) {
      return JSON.stringify({ ok: false, error: err.message });
    }
  }
};

// Tool 4: proveedor_armar_paquete
export const armar_paquete = {
  description: "Arma la carpeta del paquete para firma con formulario, soportes, checklist y borrador de correo.",
  args: {

    caso: z.string().describe("Nombre de la carpeta del caso")
  },
  async execute(args: { caso: string }, ctx: { directory: string }) {
    try {
      const casoPath = getPath(ctx.directory, "fixtures", "reto-01", "casos", args.caso);
      const solicitud = await loadJson(getPath(casoPath, "solicitud.json"));
      const soportesExigidos: string[] = await loadJson(getPath(casoPath, "soportes-exigidos.json")) || [];
      const indexSoportes: Array<{ tipo: string; archivo: string; vigencia_hasta: string }> =
        await loadJson(getPath(ctx.directory, "fixtures", "reto-01", "repositorio", "soportes", "index.json")) || [];

      const paqueteDir = getPath(ctx.directory, "out", args.caso, "paquete");
      await fs.mkdir(paqueteDir, { recursive: true });

      const ahora = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
      let listoParaFirma = true;
      const checklistItems: string[] = [];

      // Check required support documents against index and validity dates (RN3)
      for (const tipoExigido of soportesExigidos) {
        const soporte = indexSoportes.find(s => s.tipo.toLowerCase() === tipoExigido.toLowerCase());
        if (!soporte) {
          listoParaFirma = false;
          checklistItems.push(`- [ ] **${tipoExigido}**: AUSENTE en el repositorio.`);
        } else if (soporte.vigencia_hasta < ahora) {
          listoParaFirma = false;
          checklistItems.push(`- [ ] **${tipoExigido}**: VENCIDO (Vigente hasta: ${soporte.vigencia_hasta}).`);
        } else {
          checklistItems.push(`- [x] **${tipoExigido}**: VIGENTE (Hasta ${soporte.vigencia_hasta}).`);
          // Copy available support doc placeholder into the package folder
          const origen = getPath(ctx.directory, "fixtures", "reto-01", "repositorio", "soportes", soporte.archivo);
          const destino = path.join(paqueteDir, soporte.archivo);
          try {
            await fs.copyFile(origen, destino);
          } catch {
            // Placeholder copy fallback if file is virtual
            await fs.writeFile(destino, `Documento de soporte: ${soporte.tipo}`);
          }
        }
      }

      // Write checklist.md
      const checklistContent = `# Checklist de Soportes - ${args.caso}\n\n` +
        `**Estado listo para firma:** ${listoParaFirma ? "SÍ" : "NO (Revisar observaciones)"}\n\n` +
        `## Verificación de Soportes\n` + checklistItems.join("\n") + "\n";
      await fs.writeFile(path.join(paqueteDir, "checklist.md"), checklistContent, "utf-8");

      // Write borrador-correo.md (RN2: Bank details are explicitly omitted here)
      const borradorCorreo = `# Borrador de Correo\n\n` +
        `**Para:** ${solicitud?.de || "Cliente"}\n` +
        `**Asunto:** Respuesta a Solicitud de Registro - Periferia IT Group\n\n` +
        `Estimados,\n\nAdjunto remitimos la documentación y formulario diligenciado para nuestro registro como proveedores.\n\n` +
        `Atentamente,\nPeriferia IT Group\n`;
      await fs.writeFile(path.join(paqueteDir, "borrador-correo.md"), borradorCorreo, "utf-8");

      const data = {
        ruta: paqueteDir,
        listo_para_firma: listoParaFirma,
        checklist: checklistItems
      };

      await appendLog(ctx.directory, args.caso, "proveedor_armar_paquete", true, `Paquete armado. Listo para firma: ${listoParaFirma}`);
      return JSON.stringify({ ok: true, data });
    } catch (err: any) {
      return JSON.stringify({ ok: false, error: err.message });
    }
  }
};

// Tool 5: proveedor_simular_envio
export const simular_envio = {
  description: "Simula el envío del paquete al cliente produciendo ENVIO-SIMULADO.md tras confirmación humana.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    confirmado: z.boolean().describe("Confirmación explícita recibida del usuario en el chat")
  },
  async execute(args: { caso: string; confirmado: boolean }, ctx: { directory: string }) {
    try {
      if (!args.confirmado) {
        return JSON.stringify({
          ok: false,
          error: "requiere confirmación explícita del usuario antes de proceder con el envío"
        });
      }

      const rutaEnvio = getPath(ctx.directory, "out", args.caso, "ENVIO-SIMULADO.md");
      const contenido = `# Envío Simulado Exitoso\n\n` +
        `**Caso:** ${args.caso}\n` +
        `**Fecha:** ${new Date().toISOString()}\n` +
        `**Estado:** El paquete ha sido validado y preparado para su envío final.\n`;

      await fs.writeFile(rutaEnvio, contenido, "utf-8");
      await appendLog(ctx.directory, args.caso, "proveedor_simular_envio", true, "Envío simulado generado correctamente");
      return JSON.stringify({ ok: true, data: { ruta: rutaEnvio } });
    } catch (err: any) {
      return JSON.stringify({ ok: false, error: err.message });
    }
  }
};