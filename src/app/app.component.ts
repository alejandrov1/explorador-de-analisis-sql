import { ChangeDetectionStrategy, Component, signal, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GeminiService } from './services/gemini.service';
import { DbApiService } from './services/db-api.service';
import { AnalysisResult, DatabaseEngine, ObjectType, TableDependency, ColumnUsage } from './models/database-object.model';

interface SavedCredential {
  id: string;
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number;
  user: string;
  password?: string;
  dbName: string;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html', 
  styleUrls: ['./app.component.css'], 
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [CommonModule, FormsModule],
})
export class AppComponent {
  private readonly geminiService = inject(GeminiService);
  private readonly dbApiService = inject(DbApiService);

  // --- UI ---
  readonly sidebarOpen = signal<boolean>(true);

  // --- CONEXIÓN ---
  readonly dbEngine = signal<DatabaseEngine>('sqlserver'); 
  readonly host = signal<string>('localhost');
  readonly port = signal<number>(1433);
  readonly username = signal<string>('sa');
  readonly password = signal<string>(''); 
  readonly dbName = signal<string>('master');
  readonly connectionStatus = signal<'disconnected' | 'connecting' | 'connected'>('disconnected');

  // --- ANÁLISIS ---
  readonly analysisState = signal<'idle' | 'loading' | 'success' | 'error'>('idle');
  readonly objectName = signal<string>('');
  readonly objectType = signal<ObjectType>('TABLE');
  readonly sqlCode = signal<string>('');
  readonly analysisResult = signal<AnalysisResult | null>(null);
  readonly errorMessage = signal<string | null>(null);
  readonly catalogItems = signal<{ name: string; type: ObjectType; engine: string }[]>([]);
  readonly searchQuery = signal<string>('');
  readonly searchResults = computed(() => {
    const q = this.searchQuery().toLowerCase();
    return this.catalogItems().filter(item =>
      item.name.toLowerCase().includes(q) || item.type.toLowerCase().includes(q)
    );
  });

  readonly dbOptions = [
    { id: 'postgresql', name: 'PostgreSQL'}, 
    { id: 'mysql', name: 'MySQL'},
    { id: 'sqlserver', name: 'SQL Server'}
  ];
  readonly objectTypeOptions: ObjectType[] = ['TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION', 'TRIGGER'];

  selectedDb() { return this.dbOptions.find(db => db.id === this.dbEngine()); }
  toggleSidebar() { this.sidebarOpen.update(v => !v); }
  selectDbEngine(engine: string): void { this.dbEngine.set(engine as DatabaseEngine); }

  connect(): void {
    if (!this.password()) { alert("Contraseña obligatoria."); return; }
    this.connectionStatus.set('connecting');
    const config = { engine: this.dbEngine(), host: this.host(), port: this.port(), user: this.username(), password: this.password(), database: this.dbName() };
    this.dbApiService.connect(config).subscribe({
        next: (success) => { if (success) { this.connectionStatus.set('connected'); this.loadCatalog(); } },
        error: (err) => { this.connectionStatus.set('disconnected'); this.errorMessage.set(err.error?.message); this.analysisState.set('error'); }
    });
  }

  disconnect(): void { this.connectionStatus.set('disconnected'); this.analysisState.set('idle'); }

  // --- LÓGICA PRINCIPAL ---
  
  // --- GESTOR DE CREDENCIALES ---
  readonly savedConnections = signal<SavedCredential[]>([]);
  readonly selectedConnectionId = signal<string>('');

  constructor() {
    // Cargar credenciales guardadas al iniciar
    const saved = localStorage.getItem('sql_lineage_credentials');
    if (saved) {
      try {
        this.savedConnections.set(JSON.parse(saved));
      } catch (e) { console.error('Error cargando credenciales', e); }
    }
  }

  saveConnectionState(): void {
    const name = window.prompt('Nombre para esta conexión (ej. Producción):');
    if (!name) return;

    const newCred: SavedCredential = {
      id: crypto.randomUUID(),
      name,
      engine: this.dbEngine(),
      host: this.host(),
      port: this.port(),
      user: this.username(),
      password: this.password(),
      dbName: this.dbName()
    };

    this.savedConnections.update(prev => [...prev, newCred]);
    this.persistCredentials();
    this.selectedConnectionId.set(newCred.id);
  }

  loadSavedConnection(id: string): void {
    const cred = this.savedConnections().find(c => c.id === id);
    if (!cred) return;

    this.selectedConnectionId.set(id);
    
    // Cargar valores en el formulario
    this.selectDbEngine(cred.engine); // Asegura actualizar la UI del motor
    this.host.set(cred.host);
    this.port.set(cred.port);
    this.username.set(cred.user);
    this.password.set(cred.password || '');
    this.dbName.set(cred.dbName);
  }

  deleteSavedConnection(): void {
    const id = this.selectedConnectionId();
    if (!id) return;
    
    if (confirm('¿Eliminar esta credencial guardada?')) {
        this.savedConnections.update(prev => prev.filter(c => c.id !== id));
        this.selectedConnectionId.set('');
        this.persistCredentials();
    }
  }

  private persistCredentials() {
    localStorage.setItem('sql_lineage_credentials', JSON.stringify(this.savedConnections()));
  }

  clear(): void {
    this.objectName.set('');
    this.objectType.set('TABLE');
    this.sqlCode.set('');
    this.analysisResult.set(null);
    this.analysisState.set('idle');
    this.errorMessage.set(null);
  }

  analyze() {
    const enteredSql = this.sqlCode().trim();
    const enteredName = this.objectName().trim();

    if (!enteredSql && !enteredName) {
      this.errorMessage.set('Ingresa un nombre o pega código SQL.');
      this.analysisState.set('error');
      return;
    }

    this.analysisState.set('loading');
    this.errorMessage.set(null);

    // CASO 1: Búsqueda Automática en BD
    if (!enteredSql && enteredName && this.connectionStatus() === 'connected') {
      this.dbApiService.getObjectDetails(enteredName, this.objectType()).subscribe({
        next: (resp) => {
          this.sqlCode.set(resp.ddl);
          
          // AQUÍ SEPARAMOS LAS LÓGICAS
          if (this.objectType() === 'TABLE') {
            this.processTableAnalysis(enteredName, resp.ddl, resp.analysis);
          } else {
            this.processRoutineAnalysis(enteredName, this.objectType(), resp.ddl, resp.analysis);
          }
        },
        error: (err) => {
          this.analysisState.set('error');
          this.errorMessage.set(err.error?.message || 'Error al buscar objeto.');
        }
      });
      return;
    }

    // CASO 2: Manual (Sin conexión o script pegado)
    this.processRoutineAnalysis(enteredName || "Script", this.objectType(), enteredSql, null);
  }

  // ----------------------------------------------------------
  // LÓGICA 1: TABLAS (Datos Técnicos + Descripción IA)
  // ----------------------------------------------------------
  private async processTableAnalysis(name: string, ddl: string, dbMetadata: any) {
    try {
      // 1. Consultamos a la IA (para Resumen, Sugerencias Y DESCRIPCIONES de negocio)
      const aiResult = await this.geminiService.analyzeSql(name, 'TABLE', ddl, this.dbEngine());
      
      // 2. Preparamos el resultado base
      const finalResult: AnalysisResult = { ...aiResult };

      // 3. FUSIONAMOS: Base Técnica (DB) + Comprensión (IA)
      // El backend nos manda 'columns' puros en dbMetadata para tablas.
      if (dbMetadata.columns) {
        
        // a. Mapa de descripciones funcionales de la IA
        const aiColsMap = new Map<string, string>();
        if (aiResult.dependencies && aiResult.dependencies.length > 0) {
            aiResult.dependencies.forEach(dep => {
                dep.columnsInvolved.forEach(col => {
                    // Guardamos solo si la IA dio una descripción útil
                    if(col.description && col.description.length > 2) {
                        aiColsMap.set(col.columnName.toLowerCase(), col.description);
                    }
                });
            });
        }

        // b. Iterar sobre columnas REALES (Source of Truth)
        const realColumns: ColumnUsage[] = dbMetadata.columns.map((col: any) => {
          // CONSTRUCCIÓN DE LA DESCRIPCIÓN TÉCNICA EXACTA
          const techParts = [];
          techParts.push(col.isNullable ? 'NULL' : 'NOT NULL');
          if (col.columnDefault) techParts.push(`DEFAULT ${col.columnDefault}`); // Corrección: usar columnDefault
          if (col.isPrimaryKey) techParts.push('(PK)');
          if (col.isForeignKey) techParts.push('(FK)');
          
          const techDesc = techParts.join(' ');

          // Recuperar descripción funcional de la IA
          const functionalDesc = aiColsMap.get(col.columnName.toLowerCase()) || '';

          // Combinación Final
          const finalDesc = functionalDesc 
            ? `${techDesc}. ${functionalDesc}`  // Ej: "NOT NULL (PK). Identificador único de usuario."
            : techDesc;

          return {
            columnName: col.columnName,
            dataType: col.dataType, // TIPO REAL DE BD
            usageType: ['DEFINICIÓN'],
            description: finalDesc
          };
        });

        // Reemplazamos la dependencia por la propia tabla con sus datos reales enriquecidos
        finalResult.dependencies = [{
          tableName: name,
          interaction: 'READ', 
          columnsInvolved: realColumns
        }];
      }

      this.analysisResult.set(finalResult);
      this.analysisState.set('success');

    } catch (error) { this.handleError(error); }
  }

  // ----------------------------------------------------------
  // LÓGICA 2: RUTINAS (Fix N/A types con datos reales)
  // ----------------------------------------------------------
  private async processRoutineAnalysis(name: string, type: ObjectType, ddl: string, dbMetadata: any) {
    try {
      // 1. Análisis IA
      const aiResult = await this.geminiService.analyzeSql(name, type, ddl, this.dbEngine());

      // 2. Si hay metadata real, cruzamos para arreglar tipos "UNKNOWN" o "N/A"
      if (dbMetadata && dbMetadata.dependencies) {
        const merged = this.mergeAiWithDbData(aiResult, dbMetadata.dependencies);
        this.analysisResult.set(merged);
      } else {
        this.analysisResult.set(aiResult);
      }
      
      this.analysisState.set('success');
    } catch (error) { this.handleError(error); }
  }

  // Helper para Rutinas
  private mergeAiWithDbData(aiResult: AnalysisResult, dbDeps: TableDependency[]): AnalysisResult {
    const final = { ...aiResult };
    
    // Mapa rápido de tablas reales que encontró el backend
    const dbTableMap = new Map<string, TableDependency>();
    dbDeps.forEach(d => dbTableMap.set(d.tableName.toUpperCase(), d));

    final.dependencies = final.dependencies.map(aiDep => {
      const realTable = dbTableMap.get(aiDep.tableName.toUpperCase());
      
      if (!realTable) return aiDep; 

      // Mapa de columnas reales de esta tabla
      const realColMap = new Map<string, ColumnUsage>();
      realTable.columnsInvolved.forEach(c => realColMap.set(c.columnName.toUpperCase(), c));

      // Recorremos columnas de IA y corregimos el tipo de dato
      const fixedColumns = aiDep.columnsInvolved.map(aiCol => {
        const realCol = realColMap.get(aiCol.columnName.toUpperCase());
        
        if (realCol) {
          return {
            ...aiCol,
            dataType: realCol.dataType, // ¡AQUÍ CORREGIMOS EL N/A POR EL TIPO REAL!
            // Conservamos la descripción de uso de la IA ("Se usa en WHERE")
            description: aiCol.description 
          };
        }
        return aiCol;
      });

      return { ...aiDep, columnsInvolved: fixedColumns };
    });

    return final;
  }
  
  selectCatalogItem(item: any) {
    this.objectName.set(item.name);
    this.objectType.set(item.type);
    this.sqlCode.set('');
    this.analyze();
  }

  private loadCatalog() {
    this.dbApiService.getCatalog().subscribe({
      next: (items) => this.catalogItems.set(items.map((i:any) => ({...i, type: i.type.toUpperCase()}))),
      error: (e) => console.error(e)
    });
  }

  private handleError(error: any) {
    console.error(error);
    let msg = error.message || 'Error desconocido';
    if(msg.includes('429')) msg = '⚠️ Cuota de IA excedida. Espera un momento.';
    this.errorMessage.set(msg);
    this.analysisState.set('error');
  }
  
  exportToWord(): void {
    const result = this.analysisResult();
    if (!result) return;

    const fileNameSafe = `${result.objectName || 'Analisis'}.doc`.replace(/[\\/:*?"<>|]+/g, '_');
    const now = new Date().toLocaleString();

    const parametersHtml = (result.parameters || [])
      .map(p => `<tr>
        <td>${p.name}</td>
        <td>${p.dataType}</td>
        <td>${p.mode}</td>
        <td>${p.description || ''}</td>
      </tr>`).join('');

    const depsHtml = (result.dependencies || [])
      .map(dep => {
        const cols = (dep.columnsInvolved || []).map(c => `
          <tr>
            <td>${c.columnName}</td>
            <td>${c.dataType}</td>
            <td>${(c.usageType || []).join(', ')}</td>
            <td>${c.description || ''}</td>
          </tr>`).join('');
        return `
          <h3>Tabla: ${dep.tableName} (${dep.interaction})</h3>
          <table>
            <thead><tr><th>Columna</th><th>Tipo</th><th>Uso</th><th>Detalle</th></tr></thead>
            <tbody>${cols || '<tr><td colspan="4">Sin columnas detectadas</td></tr>'}</tbody>
          </table>
        `;
      }).join('');

    const suggestionsHtml = (result.suggestions || []).map(s => `<li>${s}</li>`).join('');

    const html = `
      <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: "Segoe UI", Arial, sans-serif; color: #111; }
            h1 { margin-bottom: 0; }
            h2 { margin-top: 24px; }
            table { border-collapse: collapse; width: 100%; margin: 10px 0; }
            th, td { border: 1px solid #ccc; padding: 6px 8px; font-size: 12px; }
            th { background: #f3f3f3; text-align: left; }
            pre { background: #f7f7f7; padding: 10px; border: 1px solid #ddd; overflow: auto; }
            ul { margin: 0 0 0 16px; }
          </style>
        </head>
        <body>
          <h1>Informe de Análisis SQL</h1>
          <p><strong>Fecha:</strong> ${now}</p>
          <p><strong>Objeto:</strong> ${result.objectName || 'Script Manual'} (${result.objectType})</p>
          <p><strong>Motor:</strong> ${this.dbEngine()}</p>

          <h2>Resumen</h2>
          <p>${result.summary || 'N/A'}</p>
          ${suggestionsHtml ? `<ul>${suggestionsHtml}</ul>` : ''}

          <h2>SQL Analizado</h2>
          <pre>${result.fullScript || ''}</pre>

          ${(result.parameters && result.parameters.length) ? `
            <h2>Parámetros</h2>
            <table>
              <thead><tr><th>Nombre</th><th>Tipo</th><th>Modo</th><th>Descripción</th></tr></thead>
              <tbody>${parametersHtml}</tbody>
            </table>
          ` : ''}

          <h2>Tablas y Columnas</h2>
          ${depsHtml || '<p>Sin dependencias detectadas.</p>'}
        </body>
      </html>
    `;

    const blob = new Blob([html], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileNameSafe;
    link.click();
    URL.revokeObjectURL(url);
  }
}