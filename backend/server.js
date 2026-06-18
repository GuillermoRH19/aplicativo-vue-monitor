require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT     = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Conectado a MongoDB Exitosamente'))
  .catch(err => console.error('❌ Error conectando a MongoDB:', err));

const RegistroSchema = new mongoose.Schema({}, { strict: false });

function getModelo(collectionName) {
  return mongoose.models[collectionName]
    || mongoose.model(collectionName, RegistroSchema, collectionName);
}

// ──────────────────────────────────────────────────────────────────
//  GET /api/datos
//  ?collection=<nombre>  — colección a consultar (default: sensor_readings)
//  ?sensorType=<tipo>    — filtrar por SensorType (temperature, humidity…)
//  ?deviceCode=<codigo>  — filtrar por DeviceCode (esp32-001…)
//  ?limit=<n>            — máximo de registros   (default: 500)
// ──────────────────────────────────────────────────────────────────
app.get('/api/datos', async (req, res) => {
  try {
    const collectionName = req.query.collection || 'sensor_readings';
    const limit          = parseInt(req.query.limit) || 500;

    const filtro = {};
    if (req.query.sensorType) filtro.SensorType = req.query.sensorType;
    if (req.query.deviceCode) filtro.DeviceCode  = req.query.deviceCode;

    const Modelo = getModelo(collectionName);

    let datos = await Modelo.find(filtro)
      .sort({ Timestamp: -1 })
      .limit(limit)
      .lean();

    datos = datos.reverse();
    res.json(datos);
  } catch (error) {
    console.error('Error obteniendo datos:', error);
    res.status(500).json({ error: 'Error interno del servidor', detalle: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────
//  GET /api/dispositivos
//  Devuelve TODOS los dispositivos únicos con su conteo total y el
//  timestamp de su último registro. Usa agregación — sin límite.
//  ?collection=<nombre>
// ──────────────────────────────────────────────────────────────────
app.get('/api/dispositivos', async (req, res) => {
  try {
    const collectionName = req.query.collection || 'sensor_readings';
    const Modelo = getModelo(collectionName);

    const pipeline = [
      {
        $group: {
          _id:           '$DeviceCode',
          count:         { $sum: 1 },
          lastTimestamp: { $max: '$Timestamp' },
        },
      },
      { $sort: { count: -1 } },
    ];

    const resultado = await Modelo.aggregate(pipeline);
    const respuesta = resultado.map(d => ({
      DeviceCode:    d._id,
      count:         d.count,
      lastTimestamp: d.lastTimestamp,
    }));

    res.json(respuesta);
  } catch (error) {
    console.error('Error en /api/dispositivos:', error);
    res.status(500).json({ error: 'Error interno del servidor', detalle: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────
//  GET /api/sensores
//  Último valor de cada SensorType agrupado por tipo
// ──────────────────────────────────────────────────────────────────
app.get('/api/sensores', async (req, res) => {
  try {
    const collectionName = req.query.collection || 'sensor_readings';
    const Modelo = getModelo(collectionName);

    const pipeline = [
      { $sort: { Timestamp: -1 } },
      {
        $group: {
          _id:        '$SensorType',
          lastValue:  { $first: '$Value' },
          deviceCode: { $first: '$DeviceCode' },
          timestamp:  { $first: '$Timestamp' },
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

// ──────────────────────────────────────────────────────────────────
//  GET /api/diagnostico
// ──────────────────────────────────────────────────────────────────
app.get('/api/diagnostico', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const colecciones = await db.listCollections().toArray();
    const resultado = await Promise.all(
      colecciones.map(async (col) => ({
        coleccion:   col.name,
        documentos: await db.collection(col.name).countDocuments(),
      }))
    );
    res.json({ base_de_datos: db.databaseName, colecciones: resultado });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    rutas: [
      'GET /api/datos?collection=sensor_readings&sensorType=temperature&limit=500',
      'GET /api/dispositivos?collection=sensor_readings',
      'GET /api/sensores?collection=sensor_readings',
      'GET /api/diagnostico',
    ],
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor backend corriendo en http://localhost:${PORT}`);
});
