import express, { Request, Response } from "express";
import cors from "cors";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { LLMAdapter } from "./llm/openai";
import * as proveedorTools from "./tools/proveedor";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());



const PORT = process.env.PORT || 3000;
const rootDir = process.cwd();
app.use(express.static(path.join(rootDir, "web"))); // Serves the frontend chat UI
// Initialize LLM Adapter
const llm = new LLMAdapter(process.env.LLM_MODEL || "gpt-4o");

// In-memory session store (Session ID -> Messages History)
const sessions = new Map<string, Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; name?: string }>>();

// Load System Prompt from agent/prompt.md on startup
async function loadSystemPrompt(): Promise<string> {
  try {
    return await fs.readFile(path.join(rootDir, "agent", "prompt.md"), "utf-8");
  } catch {
    return "Eres un asistente experto en automatizar el registro de proveedores para Periferia IT Group.";
  }
}

// Convert Zod tools to OpenAI tool definitions format
const toolsMap: Record<string, any> = {
  proveedor_leer_solicitud: proveedorTools.leer_solicitud,
  proveedor_mapear_campos: proveedorTools.mapear_campos,
  proveedor_generar_formulario: proveedorTools.generar_formulario,
  proveedor_armar_paquete: proveedorTools.armar_paquete,
  proveedor_simular_envio: proveedorTools.simular_envio,
};

const openaiTools = Object.keys(toolsMap).map((name) => {
  const tool = toolsMap[name];
  // Simple conversion of Zod schema keys for demonstration; 
  // In a full production setup, use zod-to-json-schema if needed.
  return {
    type: "function" as const,
    function: {
      name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: {
          caso: { type: "string", description: "Nombre de la carpeta del caso en fixtures/reto-01/casos/" },
          campos: { type: "array", items: { type: "string" }, description: "Lista de campos solicitados" },
          mapeo: { type: "object", description: "Objeto de mapeo de campos" },
          confirmado: { type: "boolean", description: "Confirmación explícita del usuario" }
        },
        required: ["caso"]
      }
    }
  };
});

// --- API Endpoints ---

// Health check endpoint (PRD Section 6.4)
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    provider: "openai",
    model: process.env.LLM_MODEL || "gpt-4o",
    timestamp: new Date().toISOString()
  });
});

// Get session history
app.get("/api/sessions/:id", (req: Request, res: Response) => {
  const sessionId = req.params.id;
  const history = sessions.get(sessionId) || [];
  res.json({ ok: true, sessionId, history });
});

//**  Main Chat endpoint executing agent loop & tool calls



app.post("/api/chat", async (req: Request, res: Response) => {
  try {
    console.log("-> Incoming chat request:", req.body);
    const { sessionId = "default-session", message } = req.body;
    if (!message) {
      res.status(400).json({ ok: false, error: "El campo 'message' es obligatorio." });
      return;
    }
    
    if (!sessions.has(sessionId)) {
      const systemPrompt = await loadSystemPrompt();
      sessions.set(sessionId, [{ role: "system", content: systemPrompt }]);
    }

    const history = sessions.get(sessionId)!;
    history.push({ role: "user", content: message });

    const executedToolCalls: Array<{ name: string; args: any; result: any }> = [];
    let maxIterations = 10;
    let iteration = 0;
    let finalReply = "";

    while (iteration < maxIterations) {
      iteration++;
      console.log(`-> Calling LLM iteration ${iteration}...`);
      const responseMessage = await llm.chat(history, openaiTools);
      console.log(`<- LLM responded. Tool calls:`, responseMessage.tool_calls ? responseMessage.tool_calls.length : 0);

      if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        history.push({
          role: "assistant",
          content: responseMessage.content || "",
          ... (responseMessage as any).tool_calls ? { tool_calls: responseMessage.tool_calls } : {}
        } as any);

        for (const toolCall of responseMessage.tool_calls) {
          const fnName = toolCall.function.name;
          const fnArgs = JSON.parse(toolCall.function.arguments || "{}");
          console.log(`-> Executing tool: ${fnName} with args:`, fnArgs);
          const tool = toolsMap[fnName];

          let toolResultString = JSON.stringify({ ok: false, error: "Herramienta no encontrada" });
          if (tool) {
            try {
              toolResultString = await tool.execute(fnArgs, { directory: rootDir, sessionId });
            } catch (err: any) {
              toolResultString = JSON.stringify({ ok: false, error: err.message });
            }
          }

          executedToolCalls.push({
            name: fnName,
            args: fnArgs,
            result: JSON.parse(toolResultString)
          });

          history.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: fnName,
            content: toolResultString
          });
        }
      } else {
        finalReply = responseMessage.content || "Proceso completado.";
        history.push({ role: "assistant", content: finalReply });
        break;
      }
    }

    res.json({
      ok: true,
      sessionId,
      reply: finalReply,
      toolCalls: executedToolCalls
    });

  } catch (err: any) {
    console.error("❌ Error in /api/chat:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`   PERIFERIA IT GROUP - AGENT BACKEND RUNNING`);
  console.log(`   Server listening on port http://localhost:${PORT}`);
  console.log(`=================================================`);
});
