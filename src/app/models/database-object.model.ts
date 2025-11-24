export type DatabaseEngine = 'postgresql' | 'mysql' | 'sqlserver';
export type ObjectType = 'VIEW' | 'TABLE' | 'PROCEDURE' | 'FUNCTION' | 'TRIGGER';

// --- Estructuras para el Análisis Detallado ---

export interface SqlParameter {
  name: string;
  dataType: string;
  mode: 'IN' | 'OUT' | 'INOUT';
  description?: string;
}

export interface ColumnUsage {
  columnName: string;
  dataType: string;
  // Qué operación se realiza: 'FILTER' (Where), 'JOIN', 'UPDATE', 'INSERT', 'SELECT'
  usageType: string[]; 
  description?: string;
}

export interface TableDependency {
  tableName: string;
  interaction: 'READ' | 'WRITE' | 'BOTH';
  columnsInvolved: ColumnUsage[];
}

export interface AnalysisResult {
  objectName: string;
  objectType: ObjectType;
  summary: string; // Resumen funcional en lenguaje natural
  
  // Específico para Procedimientos/Funciones
  parameters?: SqlParameter[];
  
  // Dependencias y uso de datos (Tablas y sus columnas)
  dependencies: TableDependency[];
  
  // Sugerencias adicionales (Indices, Seguridad, etc.)
  suggestions?: string[];
  
  // El código fuente analizado
  fullScript: string;
}

// --- Catálogo Simulado (Information Schema Mock) ---
export interface CatalogItem {
  name: string;
  type: ObjectType;
  engine: DatabaseEngine;
  ddl: string; 
}

export const MOCK_CATALOG: CatalogItem[] = [
  {
    name: 'tbl_users',
    type: 'TABLE',
    engine: 'postgresql',
    ddl: `CREATE TABLE tbl_users (
    user_id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT true
);`
  },
  {
    name: 'sp_procesar_venta',
    type: 'PROCEDURE',
    engine: 'postgresql',
    ddl: `
CREATE OR REPLACE PROCEDURE sp_procesar_venta(
    p_cliente_id INT,
    p_producto_id INT,
    p_cantidad INT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_stock_actual INT;
BEGIN
    -- Consultar Stock
    SELECT stock INTO v_stock_actual FROM tbl_productos WHERE id = p_producto_id;

    IF v_stock_actual >= p_cantidad THEN
        -- Actualizar Inventario
        UPDATE tbl_productos SET stock = stock - p_cantidad WHERE id = p_producto_id;
        
        -- Registrar Venta
        INSERT INTO tbl_ventas (cliente_id, producto_id, cantidad, fecha)
        VALUES (p_cliente_id, p_producto_id, p_cantidad, NOW());
    END IF;
END;
$$;`
  },
  {
    name: 'v_resumen_ventas',
    type: 'VIEW',
    engine: 'postgresql',
    ddl: `CREATE VIEW v_resumen_ventas AS
SELECT p.nombre, SUM(v.cantidad) as total_vendido
FROM tbl_ventas v
JOIN tbl_productos p ON v.producto_id = p.id
GROUP BY p.nombre;`
  }
];