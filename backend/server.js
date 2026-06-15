require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

// Conexión a MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Conectado a MongoDB Exitosamente'))
  .catch(err => console.error('❌ Error conectando a MongoDB:', err));

// Esquema genérico y flexible (acepta cualquier estructura de documento)
const RegistroSchema = new mongoose.Schema({}, { strict: false });

// ──────────────────────────────────────────────────────────
//  GET /api/datos
//  Parámetros opcionales de query:
//    ?collection=<nombre>    — colección a consultar (default: 'sensor_readings')
//    ?sensorType=<tipo>      — filtrar por tipo de sensor (temperature, humidity, etc.)
//    ?deviceCode=<codigo>    — filtrar por dispositivo (esp32-001, etc.)
//    ?limit=<n>              — cantidad máxima de registros (default: 100)
// ──────────────────────────────────────────────────────────
app.get('/api/datos', async (req, res) => {
  try {
    const collectionName = req.query.collection || 'sensor_readings';
    const limit          = parseInt(req.query.limit) || 100;

    // Construir filtro dinámico
    const filtro = {};
    if (req.query.sensorType) filtro.sensorType = req.query.sensorType;
    if (req.query.deviceCode)  filtro.deviceCode  = req.query.deviceCode;

    const Modelo = mongoose.models[collectionName]
      || mongoose.model(collectionName, RegistroSchema, collectionName);

    // Traer los últimos N registros (más recientes primero por timestamp, luego invertir para gráficas)
    let datos = await Modelo.find(filtro)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    datos = datos.reverse(); // Dejar del más viejo al más nuevo (correcto para gráficas de tiempo)

    res.json(datos);
  } catch (error) {
    console.error('Error obteniendo datos:', error);
    res.status(500).json({ error: 'Error interno del servidor', detalle: error.message });
  }
});

// ──────────────────────────────────────────────────────────
//  GET /api/sensores
//  Devuelve los últimos valores agrupados por sensorType y deviceCode
//  Útil para las tarjetas de métricas del panel
// ──────────────────────────────────────────────────────────
app.get('/api/sensores', async (req, res) => {
  try {
    const collectionName = req.query.collection || 'sensor_readings';
    const Modelo = mongoose.models[collectionName]
      || mongoose.model(collectionName, RegistroSchema, collectionName);

    // Agrupar por sensorType — obtener el último valor de cada tipo
    const pipeline = [
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: '$sensorType',
          lastValue:    { $first: '$value' },
          unit:         { $first: '$unit' },
          deviceCode:   { $first: '$deviceCode' },
          sensorCode:   { $first: '$sensorCode' },
          timestamp:    { $first: '$timestamp' },
        },
      },
    ];

    const resumen = await Modelo.aggregate(pipeline);
    res.json(resumen);
  } catch (error) {
    console.error('Error en /api/sensores:', error);
    res.status(500).json({ error: 'Error interno del servidor', detalle: error.message });
  }
});

// Ruta de diagnóstico general
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    rutas: [
      'GET /api/datos?collection=sensor_readings&sensorType=temperature&limit=100',
      'GET /api/sensores?collection=sensor_readings',
      'GET /api/diagnostico  → lista colecciones y conteo de documentos',
    ],
  });
});

// ──────────────────────────────────────────────────────────
//  GET /api/diagnostico
//  Lista todas las colecciones de la BD y su cantidad de documentos.
//  Útil para saber en cuál colección están llegando los datos de Kafka.
// ──────────────────────────────────────────────────────────
app.get('/api/diagnostico', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const colecciones = await db.listCollections().toArray();
    const resultado = await Promise.all(
      colecciones.map(async (col) => ({
        coleccion: col.name,
        documentos: await db.collection(col.name).countDocuments(),
      }))
    );
    res.json({ base_de_datos: db.databaseName, colecciones: resultado });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor backend corriendo en http://localhost:${PORT}`);
});
