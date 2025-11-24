import { Injectable } from '@angular/core';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AnalysisResult, DatabaseEngine, ObjectType } from '../models/database-object.model';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class GeminiService {
  private genAI: GoogleGenerativeAI | null = null;

  constructor() {
    this.initClient();
  }

  private initClient() {
    const apiKey = environment.geminiApiKey;
    if (!apiKey || apiKey.includes('TU_API_KEY') || apiKey.length < 10) {
      console.warn("API Key de Gemini no válida.");
      return;
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async analyzeSql(
    objectName: string,
    objectType: ObjectType,
    sqlCode: string,
    dbEngine: DatabaseEngine
  ): Promise<AnalysisResult> {
    
    if (!this.genAI) {
      this.initClient();
      if (!this.genAI) throw new Error("API Key no configurada.");
    }

    const modelName = "gemini-2.0-flash"; 
    const model = this.genAI!.getGenerativeModel({ model: modelName });

    // CAMBIO CLAVE: Eliminamos 'fullScript' del JSON que pedimos a la IA para evitar errores de sintaxis
    const prompt = `
      Actúa como un Arquitecto de Base de Datos Senior. Analiza el siguiente código DDL (${dbEngine}):
      
      OBJETO: ${objectName} (${objectType})
      CÓDIGO:
      ---
      ${sqlCode}
      ---

      TAREA: Realizar un análisis de linaje detallado y retornar un JSON puro.
      
      1. **Dependencias**: Identifica TODAS las tablas referenciadas.
      2. **Detalle de Columnas**: Para CADA tabla, lista las columnas usadas basándote en el código.
      3. **Resumen**: Explica la lógica de negocio.

      REGLAS IMPORTANTES:
      - Retorna SOLO JSON válido.
      - NO incluyas saltos de línea literales dentro de los valores de texto (usa \\n si es necesario).
      - NO incluyas el campo 'fullScript' en la respuesta.

      Estructura JSON esperada:
      {
        "objectName": "${objectName}",
        "objectType": "${objectType}",
        "summary": "Descripción funcional concisa...",
        "parameters": [
          { "name": "nombre_param", "dataType": "TIPO", "mode": "IN/OUT", "description": "Breve descripción" }
        ],
        "dependencies": [
          {
            "tableName": "Nombre_Tabla",
            "interaction": "READ | WRITE | BOTH",
            "columnsInvolved": [
              { 
                "columnName": "columna", 
                "dataType": "TIPO", 
                "usageType": ["SELECT", "WHERE"], 
                "description": "Uso técnico" 
              }
            ]
          }
        ],
        "suggestions": ["Sugerencia 1"]
      }
    `;

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      const cleanedJson = this.cleanJson(text);
      
      // Parseamos el JSON de la IA
      const parsedData = JSON.parse(cleanedJson) as AnalysisResult;

      // INYECCIÓN MANUAL: Agregamos el script original aquí de forma segura
      // Esto evita que la IA tenga que escapar caracteres complejos dentro del JSON
      parsedData.fullScript = sqlCode;

      return parsedData;

    } catch (error: any) {
        console.error("Error Gemini Raw Text:", error);
        throw new Error(`Error procesando respuesta de IA: ${error.message}`);
    }
  }

  private cleanJson(text: string): string {
    let clean = text.trim();
    // Eliminar bloques de código markdown si existen
    if (clean.startsWith('```')) {
      clean = clean.replace(/^```(json)?/i, '').replace(/```$/, '');
    }
    return clean.trim();
  }
}