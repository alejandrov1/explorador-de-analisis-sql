const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Client } = require('pg');
const mysql = require('mysql2/promise');
const sql = require('mssql');

const app = express();
app.use(cors());
app.use(bodyParser.json());

let activeConfig = null;
let activeEngine = null;

// --- Función CORE: Obtener metadatos técnicos reales ---
async function getTableColumns(tableName) {
    if (!activeConfig || !activeEngine) throw new Error("No hay conexión activa");

    if (activeEngine === 'postgresql') {
        const client = new Client(activeConfig);
        await client.connect();
        const cols = await client.query(`
            SELECT column_name, data_type, is_nullable, column_default,
                   character_maximum_length, numeric_precision, numeric_scale
            FROM information_schema.columns
            WHERE table_name = $1
            ORDER BY ordinal_position;
        `, [tableName]);

        const pk = await client.query(`
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1;
        `, [tableName]);

        const fk = await client.query(`
            SELECT kcu.column_name, ccu.table_name AS fk_table, ccu.column_name AS fk_column
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1;
        `, [tableName]);

        await client.end();

        const pkSet = new Set(pk.rows.map(r => r.column_name));
        const fkMap = new Map(fk.rows.map(r => [r.column_name, { table: r.fk_table, column: r.fk_column }]));

        return cols.rows.map(col => ({
            columnName: col.column_name,
            dataType: col.data_type,
            length: col.character_maximum_length,
            precision: col.numeric_precision,
            scale: col.numeric_scale,
            isNullable: col.is_nullable === 'YES',
            columnDefault: col.column_default || null,
            isPrimaryKey: pkSet.has(col.column_name),
            isForeignKey: fkMap.has(col.column_name),
            references: fkMap.get(col.column_name) || null
        }));
    }

    if (activeEngine === 'mysql') {
        const conn = await mysql.createConnection(activeConfig);
        const [cols] = await conn.query(`
            SELECT column_name, data_type, is_nullable, column_default,
                   character_maximum_length, numeric_precision, numeric_scale
            FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = ?
            ORDER BY ordinal_position;
        `, [tableName]);

        const [pk] = await conn.query(`
            SELECT column_name FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = ? AND index_name = 'PRIMARY';
        `, [tableName]);

        const [fk] = await conn.query(`
            SELECT k.column_name, k.referenced_table_name AS fk_table, k.referenced_column_name AS fk_column
            FROM information_schema.key_column_usage k
            WHERE k.table_schema = DATABASE() AND k.table_name = ? AND k.referenced_table_name IS NOT NULL;
        `, [tableName]);
        await conn.end();

        const pkSet = new Set(pk.map(r => r.column_name));
        const fkMap = new Map(fk.map(r => [r.column_name, { table: r.fk_table, column: r.fk_column }]));

        return cols.map(col => ({
            columnName: col.column_name,
            dataType: col.data_type,
            length: col.character_maximum_length,
            precision: col.numeric_precision,
            scale: col.numeric_scale,
            isNullable: col.is_nullable === 'YES',
            columnDefault: col.column_default || null,
            isPrimaryKey: pkSet.has(col.column_name),
            isForeignKey: fkMap.has(col.column_name),
            references: fkMap.get(col.column_name) || null
        }));
    }

    if (activeEngine === 'sqlserver') {
        await sql.connect({
            ...activeConfig,
            server: activeConfig.host,
            options: { encrypt: false, trustServerCertificate: true }
        });

        const colsRes = await sql.query`
            SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
                   CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = ${tableName}
            ORDER BY ORDINAL_POSITION;
        `;

        const pkRes = await sql.query`
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
              ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
            WHERE tc.TABLE_NAME = ${tableName} AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY';
        `;

        const fkRes = await sql.query`
            SELECT kcu.COLUMN_NAME, ccu.TABLE_NAME AS fk_table, ccu.COLUMN_NAME AS fk_column
            FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
              ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
            JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
              ON ccu.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME
            WHERE kcu.TABLE_NAME = ${tableName};
        `;
        await sql.close();

        const pkSet = new Set(pkRes.recordset.map(r => r.COLUMN_NAME));
        const fkMap = new Map(fkRes.recordset.map(r => [r.COLUMN_NAME, { table: r.fk_table, column: r.fk_column }]));

        return colsRes.recordset.map(col => ({
            columnName: col.COLUMN_NAME,
            dataType: col.DATA_TYPE,
            length: col.CHARACTER_MAXIMUM_LENGTH,
            precision: col.NUMERIC_PRECISION,
            scale: col.NUMERIC_SCALE,
            isNullable: col.IS_NULLABLE === 'YES',
            columnDefault: col.COLUMN_DEFAULT || null,
            isPrimaryKey: pkSet.has(col.COLUMN_NAME),
            isForeignKey: fkMap.has(col.COLUMN_NAME),
            references: fkMap.get(col.COLUMN_NAME) || null
        }));
    }

    throw new Error("Motor no soportado");
}

// Parámetros para SPs/Funciones
async function getRoutineParameters(objectName) {
    // (Se puede implementar similar a getTableColumns si se requiere detalle de params)
    return []; 
}

// Análisis de dependencias para vistas/procs
async function getDependencies(objectName, objectType, ddl) {
    if (!activeConfig || !activeEngine) throw new Error("No hay conexión activa");

    let identifiedTables = new Set();
    
    // 1. Buscar dependencias usando catálogos del sistema
    if (activeEngine === 'postgresql') {
        const client = new Client(activeConfig);
        await client.connect();
        const usageQuery = objectType === 'VIEW' 
            ? `SELECT table_name FROM information_schema.view_table_usage WHERE view_name = $1`
            : `SELECT table_name FROM information_schema.routine_table_usage WHERE specific_name = $1`; 
        try {
            const res = await client.query(usageQuery, [objectName]);
            res.rows.forEach(r => identifiedTables.add(r.table_name));
        } catch(e) { console.log("Info schema query failed, fallback to regex"); }
        await client.end();
    } else if (activeEngine === 'sqlserver') {
        try {
            await sql.connect({ ...activeConfig, server: activeConfig.host, options: { encrypt: false, trustServerCertificate: true } });
            const res = await sql.query`SELECT referenced_entity_name AS table_name FROM sys.dm_sql_referenced_entities (${objectName}, 'OBJECT') WHERE referenced_minor_name IS NULL;`;
            res.recordset.forEach(r => identifiedTables.add(r.table_name));
            await sql.close();
        } catch(e) { console.log("Sys.depends failed, fallback to regex"); }
    }

    // 2. Regex fallback simple
    const regex = /\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO)\s+([a-zA-Z0-9_]+)/gi;
    let m;
    while ((m = regex.exec(ddl)) !== null) {
        if (m[1].toUpperCase() !== objectName.toUpperCase()) identifiedTables.add(m[1]);
    }

    const finalDependencies = [];
    const ddlLower = ddl.toLowerCase();

    for (const tableName of identifiedTables) {
        try {
            const realColumns = await getTableColumns(tableName);
            const columnsInvolved = [];
            
            // Filtramos solo las columnas mencionadas en el script
            // IMPORTANTE: Si no se menciona ninguna, devolvemos TODAS (caso SELECT *) para que el frontend tenga tipos reales
            let foundAny = false;
            for (const col of realColumns) {
                if (ddlLower.includes(col.columnName.toLowerCase())) {
                    foundAny = true;
                    columnsInvolved.push({
                        columnName: col.columnName,
                        dataType: col.dataType + formatLength(col),
                        usageType: ['READ/WRITE'], 
                        description: `${col.isPrimaryKey ? 'PK ' : ''}${col.isForeignKey ? 'FK ' : ''}`.trim()
                    });
                }
            }

            if (!foundAny && realColumns.length > 0) {
                 realColumns.forEach(col => {
                    columnsInvolved.push({
                        columnName: col.columnName,
                        dataType: col.dataType + formatLength(col),
                        usageType: ['IMPLICIT'], 
                        description: ''
                    });
                 });
            }

            finalDependencies.push({
                tableName: tableName,
                interaction: 'READ', 
                columnsInvolved: columnsInvolved
            });

        } catch (e) {
            // Tabla temporal o no existe
        }
    }
    return finalDependencies;
}

function formatLength(col) {
    if (col.length) return `(${col.length})`;
    if (col.precision) return `(${col.precision})`;
    return '';
}

async function fetchDdl(objectName, objectType) {
    if (!activeConfig) throw new Error("No hay conexión");
    
    if (activeEngine === 'sqlserver') {
        await sql.connect({ ...activeConfig, server: activeConfig.host, options: { encrypt: false, trustServerCertificate: true } });
        let ddl = "";
        if (objectType === 'TABLE') {
             // Reconstrucción básica para tener un script que analizar
             const cols = await sql.query`SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ${objectName}`;
             ddl = `CREATE TABLE ${objectName} ( \n` + cols.recordset.map(c => `  ${c.COLUMN_NAME} ${c.DATA_TYPE}`).join(',\n') + `\n);`;
        } else {
             const res = await sql.query`SELECT OBJECT_DEFINITION(OBJECT_ID(${objectName})) AS DDL`;
             ddl = res.recordset[0]?.DDL || '-- No definition found';
        }
        await sql.close();
        return ddl;
    }
    // Nota: Para Postgres y MySQL usa la lógica existente que tenías, simplificada aquí para SQL Server como ejemplo principal
    return "-- DDL Fetcher (Motor no implementado completamente en este snippet reducido)";
}

// API CONNECT
app.post('/api/connect', async (req, res) => {
    const { engine, host, port, user, password, database } = req.body;
    try {
        activeConfig = { host, port, user, password, database };
        activeEngine = engine;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// API DETAILS
app.post('/api/object-details', async (req, res) => {
    const { objectName, objectType } = req.body;
    if (!activeConfig) return res.status(400).json({ message: "No hay conexión" });

    try {
        const ddl = await fetchDdl(objectName, objectType);
        let analysis = { dependencies: [] };

        // 1. SI ES TABLA: Obtenemos metadatos RAW completos
        if (objectType === 'TABLE') {
            const cols = await getTableColumns(objectName);
            // Enviamos la estructura cruda para que el frontend la formatee
            analysis.columns = cols.map(col => ({
                columnName: col.columnName,
                dataType: col.dataType + formatLength(col),
                isNullable: col.isNullable,
                columnDefault: col.columnDefault, // Asegurar nombre correcto
                isPrimaryKey: col.isPrimaryKey,
                isForeignKey: col.isForeignKey,
                references: col.references // Info extra de FK
            }));
            
            // Dummy dependency para compatibilidad básica
            analysis.dependencies = [{ tableName: objectName, interaction: 'READ', columnsInvolved: [] }];
        } 
        // 2. SI ES RUTINA: Usamos la lógica de dependencias
        else {
            analysis.dependencies = await getDependencies(objectName, objectType, ddl);
        }

        res.json({ success: true, ddl, analysis });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: e.message });
    }
});

app.get('/api/catalog', async (req, res) => {
    if (!activeConfig || !activeEngine) {
        return res.json({ success: true, items: [] });
    }

    try {
        let rawItems = [];

        if (activeEngine === 'postgresql') {
            const client = new Client(activeConfig);
            await client.connect();
            const tables = await client.query(`SELECT table_name as name, table_type as type FROM information_schema.tables WHERE table_schema = 'public'`);
            const routines = await client.query(`SELECT routine_name as name, routine_type as type FROM information_schema.routines WHERE routine_schema = 'public'`);            
            const triggers = await client.query(`SELECTKZ trigger_name as name, 'TRIGGER' as type FROM information_schema.triggers WHERE event_object_schema = 'public'`);
            
            await client.end();
            rawItems = [...tables.rows, ...routines.rows, ...triggers.rows];
        } 
        else if (activeEngine === 'mysql') {
            const mysqlPromise = require('mysql2/promise'); 
            const conn = await mysqlPromise.createConnection(activeConfig);
            
            const [tables] = await conn.query(`SELECT TABLE_NAME as name, TABLE_TYPE as type FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`);
            const [routines] = await conn.query(`SELECT ROUTINE_NAME as name, ROUTINE_TYPE as type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()`);
            const [triggers] = await conn.query(`SELECT TRIGGER_NAME as name, 'TRIGGER' as type FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()`);
            
            await conn.end();
            rawItems = [...tables, ...routines, ...triggers];
        } 
        else if (activeEngine === 'sqlserver') {
            await sql.connect({
                ...activeConfig,
                server: activeConfig.host,
                options: { encrypt: false, trustServerCertificate: true }
            });
            const tables = await sql.query`SELECT TABLE_NAME as name, TABLE_TYPE as type FROM INFORMATION_SCHEMA.TABLES`;
            const routines = await sql.query`SELECT ROUTINE_NAME as name, ROUTINE_TYPE as type FROM INFORMATION_SCHEMA.ROUTINES`;
            // AGREGADO: Consulta de Triggers (Usando sys.triggers ya que no siempre está en INFORMATION_SCHEMA de forma directa para listado simple)
            const triggers = await sql.query`SELECT name, 'TRIGGER' as type FROM sys.triggers`;
            
            await sql.close();
            rawItems = [...tables.recordset, ...routines.recordset, ...triggers.recordset];
        }

        const items = rawItems.map(item => {
            let type = item.type ? item.type.toUpperCase() : 'UNKNOWN';
            if (type === 'BASE TABLE') type = 'TABLE';
            return { name: item.name, type: type, engine: activeEngine };
        });

        res.json({ success: true, items });

    } catch (e) {
        console.error("Error fetching catalog:", e);
        res.json({ success: false, items: [], error: e.message });
    }
});

app.listen(3000, () => console.log('Server running 3000'));
