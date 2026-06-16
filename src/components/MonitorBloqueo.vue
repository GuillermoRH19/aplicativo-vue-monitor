<script setup>
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { Chart, registerables } from 'chart.js'
Chart.register(...registerables)

// ============================================================
//  CONFIGURACIÓN — Edita aquí tus parámetros
// ============================================================
const CONFIG = {
  // ── URLs del backend (se leen de .env.local) ───────────────
  URL_API_TOP:   import.meta.env.VITE_API_URL_TOP   || 'http://localhost:3000/api/datos?collection=processed_readings',
  URL_API_TODOS: import.meta.env.VITE_API_URL_TODOS || 'http://localhost:3000/api/datos?collection=processed_readings',
  POLLING_INTERVAL_MS: 5000,

  // ── Campos usados para el ranking de actividad ────────────
  // deviceCode = identificador del ESP32 (esp32-001, esp32-002, …)
  CAMPOS_TOP: {
    DEVICE_ID: 'DeviceCode',
    COUNT: null,
  },

  // ── Campos usados para la tabla de historial ──────────────
  CAMPOS_REGISTROS: {
    ID_REGISTRO: 'Id',          // UUID del evento enviado por Kafka
    DEVICE_ID:   'DeviceCode',  // Código del ESP32 (ej. esp32-001)
    VALOR:       'Value',       // Valor numérico del sensor
    FECHA:       'Timestamp',   // Timestamp ISO 8601 del evento
  },

  // ── CONFIGURACIÓN DE SENSORES para las gráficas ──────────
  // Cada sensor kafka envía: sensorType (temperature/humidity/pressure)
  // y el valor numérico en el campo 'value'.
  // Como cada documento tiene un solo sensorType, filtramos por tipo:
  SENSORES: {
    // Sensor 1: Temperatura
    CAMPO_S1:  'Value',
    FILTER_S1: 'temperature',
    LABEL_S1:  'Temperatura',
    UNIDAD_S1: '°C',
    COLOR_S1:  '#ff4757',

    // Sensor 2: Humedad
    CAMPO_S2:  'Value',
    FILTER_S2: 'humidity',
    LABEL_S2:  'Humedad',
    UNIDAD_S2: '%',
    COLOR_S2:  '#6c8efb',

    // Sensor 3: Distancia
    CAMPO_S3:  'Value',
    FILTER_S3: 'distance',
    LABEL_S3:  'Distancia',
    UNIDAD_S3: 'cm',
    COLOR_S3:  '#2ed573',
  },

  MAX_PUNTOS_GRAFICA: 20,
  MAX_FILAS_VISIBLES: 12,

  ETIQUETAS_TABLA: {
    ID_REGISTRO: 'ID Evento',
    DEVICE_ID:   'Dispositivo',
    VALOR:       'Valor',
    FECHA:       'Timestamp',
  },

  LABELS: {
    DEVICE: 'Código Dispositivo (ESP32)',
    COUNT:  'Registros enviados',
  },
}
// ============================================================

// ── Estado: TOP de actividad ──
const estadoTop      = ref('idle')
const errorTop       = ref('')
const dispositivoAlerta = ref(null)
const ultimaActTop   = ref(null)

// ── Estado: tabla de registros ──
const estadoTabla    = ref('idle')
const errorTabla     = ref('')
const registros      = ref([])
const ultimaActTabla = ref(null)

const contadorPoll   = ref(0)

// ── Estado: Inventario de Dispositivos ──
const estadosDispositivos = ref({}) // { 'DeviceCode': { activo: true, registros: N } }

// ── Estado: datos de gráficas ──
const graficasListas = ref(false)
const historialTiempos = ref([])   // etiquetas de tiempo eje X
const historialS1  = ref([])
const historialS2  = ref([])
const historialS3  = ref([])
const conteoDispositivos = ref({}) // { deviceId: count }

let chartLinea    = null
let chartBarras   = null
let chartDona     = null
let intervalo     = null

// ────────────────────────────────────────────────────────────
//  FETCH: Top de actividad
// ────────────────────────────────────────────────────────────
async function fetchTop() {
  if (estadoTop.value === 'idle') estadoTop.value = 'cargando'
  try {
    const res = await fetch(CONFIG.URL_API_TOP)
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`)
    const data = await res.json()
    const lista = Array.isArray(data) ? data : data?.results ?? data?.data ?? []
    if (!lista.length) { estadoTop.value = 'sin-datos'; dispositivoAlerta.value = null; return }

    const conteo = {}
    lista.forEach((item) => {
      const id  = item[CONFIG.CAMPOS_TOP.DEVICE_ID] ?? 'desconocido'
      const val = CONFIG.CAMPOS_TOP.COUNT ? Number(item[CONFIG.CAMPOS_TOP.COUNT]) : 1
      conteo[id] = (conteo[id] ?? 0) + val
    })
    conteoDispositivos.value = conteo

    const [topId, topCount] = Object.entries(conteo).reduce(
      (max, entry) => (entry[1] > max[1] ? entry : max), ['', -Infinity],
    )
    dispositivoAlerta.value = {
      id: topId, count: topCount,
      porcentaje: Math.round((topCount / lista.length) * 100),
      rankingCompleto: Object.entries(conteo).sort((a, b) => b[1] - a[1]).slice(0, 5),
    }
    estadoTop.value = 'ok'
    ultimaActTop.value = new Date().toLocaleTimeString('es-MX')
  } catch (err) {
    estadoTop.value = 'error'; errorTop.value = err.message ?? 'Error desconocido'
  }
}

// ────────────────────────────────────────────────────────────
//  FETCH: Lista de registros
// ────────────────────────────────────────────────────────────
async function fetchTodos() {
  if (estadoTabla.value === 'idle') estadoTabla.value = 'cargando'
  try {
    const res = await fetch(CONFIG.URL_API_TODOS)
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`)
    const data = await res.json()
    const lista = Array.isArray(data) ? data : data?.results ?? data?.data ?? []

    const dispositivosEnCiclo = {}

    lista.forEach(item => {
      const dId = item[CONFIG.CAMPOS_REGISTROS.DEVICE_ID]
      if (!dId || String(dId).trim() === '') return
      dispositivosEnCiclo[dId] = (dispositivosEnCiclo[dId] ?? 0) + 1
    })

    const nuevoEstado = {}
    for (const dId in dispositivosEnCiclo) {
      nuevoEstado[dId] = {
        activo: true,
        registros: dispositivosEnCiclo[dId],
      }
    }

    estadosDispositivos.value = nuevoEstado
    conteoDispositivos.value = dispositivosEnCiclo

    registros.value = lista
    estadoTabla.value = lista.length ? 'ok' : 'sin-datos'
    ultimaActTabla.value = new Date().toLocaleTimeString('es-MX')
    actualizarDatosSensores(lista)
  } catch (err) {
    estadoTabla.value = 'error'
    errorTabla.value = err.message ?? 'Error desconocido'
    estadosDispositivos.value = {}
    conteoDispositivos.value = {}
  }
}
// ────────────────────────────────────────────────────────────
//  Actualizar datos de sensores para gráficas
//  Cada documento de Kafka tiene: sensorType (temperature/humidity/pressure)
//  y el valor numérico en 'value'. Filtramos por sensorType antes de extraer.
// ────────────────────────────────────────────────────────────
/**
 * Extrae el último valor de un campo dentro de la lista,
 * filtrando primero por sensorType si se proporciona filtroTipo.
 * Si no hay datos reales, genera un mock realista.
 */
function parsearSensor(lista, campo, filtroTipo, semilla) {
  if (campo) {
    const sublista = filtroTipo
      ? lista.filter(i => i.SensorType === filtroTipo)
      : lista
    const vals = sublista.map(i => parseFloat(i[campo])).filter(v => !isNaN(v))
    if (vals.length) return vals[vals.length - 1]
    // Si el tipo de sensor aún no está en los datos actuales, devuelve null
    return null
  }
  // Mock de respaldo (solo si campo es null)
  const base = (lista.length % 30) + semilla
  return parseFloat((base + Math.sin(contadorPoll.value * 0.4 + semilla) * 5).toFixed(1))
}

function actualizarDatosSensores(lista) {
  const ahora = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const max = CONFIG.MAX_PUNTOS_GRAFICA

  const s1 = parsearSensor(lista, CONFIG.SENSORES.CAMPO_S1, CONFIG.SENSORES.FILTER_S1, 22)
  const s2 = parsearSensor(lista, CONFIG.SENSORES.CAMPO_S2, CONFIG.SENSORES.FILTER_S2, 60)
  const s3 = parsearSensor(lista, CONFIG.SENSORES.CAMPO_S3, CONFIG.SENSORES.FILTER_S3, 1013)

  historialTiempos.value.push(ahora)
  historialS1.value.push(s1)
  historialS2.value.push(s2)
  historialS3.value.push(s3)

  if (historialTiempos.value.length > max) {
    historialTiempos.value.shift()
    historialS1.value.shift()
    historialS2.value.shift()
    historialS3.value.shift()
  }

  actualizarGraficas()
}

// ────────────────────────────────────────────────────────────
//  Chart.js — inicializar gráficas
// ────────────────────────────────────────────────────────────
function inicializarGraficas() {
  Chart.defaults.color = '#7a8299'
  Chart.defaults.font.family = "'Inter', 'Segoe UI', sans-serif"


  // 1. Gráfica de líneas: sensores en tiempo real
  const ctxLinea = document.getElementById('chartLinea')
  if (ctxLinea) {
    chartLinea = new Chart(ctxLinea, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: `${CONFIG.SENSORES.LABEL_S1} (${CONFIG.SENSORES.UNIDAD_S1})`,
            data: [], borderColor: CONFIG.SENSORES.COLOR_S1,
            backgroundColor: CONFIG.SENSORES.COLOR_S1 + '22',
            tension: 0.4, fill: true, pointRadius: 3, pointHoverRadius: 6,
            borderWidth: 2, borderDash: [],
          },
          {
            label: `${CONFIG.SENSORES.LABEL_S2} (${CONFIG.SENSORES.UNIDAD_S2})`,
            data: [], borderColor: CONFIG.SENSORES.COLOR_S2,
            backgroundColor: CONFIG.SENSORES.COLOR_S2 + '22',
            tension: 0.4, fill: true, pointRadius: 3, pointHoverRadius: 6,
            borderWidth: 2, borderDash: [5, 3],
          },
          {
            label: `${CONFIG.SENSORES.LABEL_S3} (${CONFIG.SENSORES.UNIDAD_S3})`,
            data: [], borderColor: CONFIG.SENSORES.COLOR_S3,
            backgroundColor: CONFIG.SENSORES.COLOR_S3 + '22',
            tension: 0.4, fill: false, pointRadius: 3, pointHoverRadius: 6,
            borderWidth: 2, borderDash: [2, 2],
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#13161e', borderColor: '#252a38', borderWidth: 1,
            titleColor: '#e4e8f0', bodyColor: '#7a8299', padding: 12,
          },
        },
        scales: {
          x: {
            grid: { color: '#252a38', drawBorder: false },
            ticks: { maxTicksLimit: 8, maxRotation: 0 },
          },
          y: {
            grid: { color: '#252a38', drawBorder: false },
            ticks: { padding: 8 },
          },
        },
      },
    })
  }

  // 2. Gráfica de barras: registros por dispositivo
  const ctxBarras = document.getElementById('chartBarras')
  if (ctxBarras) {
    chartBarras = new Chart(ctxBarras, {
      type: 'bar',
      data: { labels: [], datasets: [{ label: 'Registros', data: [], backgroundColor: [], borderRadius: 6, borderSkipped: false }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
        plugins: { legend: { display: false }, tooltip: { backgroundColor: '#13161e', borderColor: '#252a38', borderWidth: 1, titleColor: '#e4e8f0', bodyColor: '#7a8299', padding: 12 } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { family: 'monospace', size: 11 } } },
          y: { grid: { color: '#252a38', drawBorder: false }, beginAtZero: true, ticks: { precision: 0 } },
        },
      },
    })
  }

  // 3. Dona: distribución de tráfico
  const ctxDona = document.getElementById('chartDona')
  if (ctxDona) {
    chartDona = new Chart(ctxDona, {
      type: 'doughnut',
      data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderColor: '#13161e', borderWidth: 3, hoverOffset: 8 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
        cutout: '68%',
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: '#13161e', borderColor: '#252a38', borderWidth: 1, titleColor: '#e4e8f0', bodyColor: '#7a8299', padding: 12 },
        },
      },
    })
  }

  graficasListas.value = true
}

// Paleta para barras y dona
const PALETA = ['#6c8efb','#ff4757','#2ed573','#ffd93d','#ff6b35','#a29bfe','#fd79a8','#00cec9','#fdcb6e','#e17055']

function actualizarGraficas() {
  if (!graficasListas.value) return

  // Línea
  if (chartLinea) {
    chartLinea.data.labels = [...historialTiempos.value]
    chartLinea.data.datasets[0].data = [...historialS1.value]
    chartLinea.data.datasets[1].data = [...historialS2.value]
    chartLinea.data.datasets[2].data = [...historialS3.value]
    chartLinea.update('none')
  }

  // Barras + Dona
  const entries = Object.entries(conteoDispositivos.value).sort((a, b) => b[1] - a[1]).slice(0, 10)
  const labels  = entries.map(([id]) => `#${id}`)
  const vals    = entries.map(([, v]) => v)
  const colors  = entries.map((_, i) => PALETA[i % PALETA.length])

  if (chartBarras) {
    chartBarras.data.labels = labels
    chartBarras.data.datasets[0].data = vals
    chartBarras.data.datasets[0].backgroundColor = colors
    chartBarras.update('none')
  }
  if (chartDona) {
    chartDona.data.labels = labels
    chartDona.data.datasets[0].data = vals
    chartDona.data.datasets[0].backgroundColor = colors
    chartDona.update('none')
  }
}

// ────────────────────────────────────────────────────────────
//  Polling paralelo
// ────────────────────────────────────────────────────────────
async function pollCiclo() {
  contadorPoll.value++
  await Promise.all([fetchTop(), fetchTodos()])
}

// ── Computeds de Inventario ──
const totalInventario = computed(() => Object.keys(estadosDispositivos.value).length)
const activosInventario = computed(() => Object.values(estadosDispositivos.value).filter(s => s.activo).length)
const inactivosInventario = computed(() => totalInventario.value - activosInventario.value)

// ── Nivel de alerta ──
const nivelAlerta = computed(() => {
  const p = dispositivoAlerta.value?.porcentaje ?? 0
  if (p >= 70) return 'critico'
  if (p >= 40) return 'alto'
  return 'medio'
})

const etiquetaEstado = computed(() => {
  const n = nivelAlerta.value
  if (n === 'inactivo') return { texto: 'INACTIVO / SIN TRÁFICO RECIENTE', clase: 'tag-inactivo' }
  if (n === 'critico')  return { texto: 'Tráfico Excedido — Requiere Bloqueo Upstream', clase: 'tag-critico' }
  if (n === 'alto')     return { texto: 'Tráfico Elevado — Monitorear Upstream', clase: 'tag-alto' }
  return { texto: 'Tráfico Normal — Sin Acción Requerida', clase: 'tag-medio' }
})

// Último valor de cada sensor (para las tarjetas métricas)
const ultimoS1 = computed(() => historialS1.value[historialS1.value.length - 1] ?? '—')
const ultimoS2 = computed(() => historialS2.value[historialS2.value.length - 1] ?? '—')
const ultimoS3 = computed(() => historialS3.value[historialS3.value.length - 1] ?? '—')

function getCampo(item, campo) {
  const key = CONFIG.CAMPOS_REGISTROS[campo]
  if (!key) return '—'
  const val = item[key]
  return val !== undefined && val !== null && val !== '' ? val : '—'
}

// ────────────────────────────────────────────────────────────
//  Arranque
// ────────────────────────────────────────────────────────────
onMounted(async () => {
  await nextTick()
  inicializarGraficas()
  pollCiclo()
  intervalo = setInterval(pollCiclo, CONFIG.POLLING_INTERVAL_MS)
})

onUnmounted(() => {
  clearInterval(intervalo)
  chartLinea?.destroy()
  chartBarras?.destroy()
  chartDona?.destroy()
})
</script>

<template>
  <div class="monitor-container">

    <!-- ── Header ─────────────────────────────────── -->
    <header class="monitor-header">
      <div class="header-left">
        <div class="pulse-dot" :class="{ active: estadoTop === 'ok' }"></div>
        <h1>Panel de Monitoreo IoT</h1>
      </div>
      <div class="header-right">
        <span class="badge-pill">
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Ciclos: {{ contadorPoll }}
        </span>
        <span v-if="ultimaActTop" class="badge-pill">
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          {{ ultimaActTop }}
        </span>
      </div>
    </header>

    <!-- ── Body: tarjeta de alerta + ranking ───────── -->
    <div class="monitor-body">
      <div v-if="estadoTop === 'cargando'" class="estado-card estado-cargando">
        <div class="spinner"></div>
        <p>Consultando API…</p>
        <small>{{ CONFIG.URL_API_TOP }}</small>
      </div>

      <div v-else-if="estadoTop === 'error'" class="estado-card estado-error">
        <div class="estado-icon">⚠️</div>
        <h2>Error de conexión</h2>
        <p>{{ errorTop }}</p>
        <button class="btn-retry" @click="fetchTop">Reintentar</button>
      </div>

      <div v-else-if="estadoTop === 'sin-datos'" class="estado-card">
        <div class="estado-icon">📭</div>
        <h2>Sin datos disponibles</h2>
        <p>La API respondió pero no devolvió registros.</p>
      </div>

      <div v-else-if="estadoTop === 'ok' && dispositivoAlerta" class="alerta-wrapper">
        <!-- Tarjeta principal -->
        <div class="alerta-card" :class="`nivel-${nivelAlerta}`">
          <div class="alerta-badge">
            <span v-if="nivelAlerta === 'inactivo'">⚪ INACTIVO</span>
            <span v-else-if="nivelAlerta === 'critico'">🔴 CRÍTICO</span>
            <span v-else-if="nivelAlerta === 'alto'">🟠 ALTO</span>
            <span v-else>🟡 MEDIO</span>
          </div>
          <div class="alerta-titulo">
            <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span>Dispositivo con mayor actividad detectado</span>
          </div>
          <div class="alerta-device-id">
            <label>{{ CONFIG.LABELS.DEVICE }}</label>
            <div class="device-id-value">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="7" width="6" height="10" rx="1"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/></svg>
              <strong>{{ dispositivoAlerta.id }}</strong>
            </div>
          </div>
          <div class="alerta-stats">
            <div class="stat-item">
              <span class="stat-label">{{ CONFIG.LABELS.COUNT }}</span>
              <span class="stat-value">{{ dispositivoAlerta.count.toLocaleString() }}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">% del tráfico total</span>
              <span class="stat-value">{{ dispositivoAlerta.porcentaje }}%</span>
            </div>
          </div>
          <div class="progress-bar-wrapper">
            <div class="progress-bar-track">
              <div class="progress-bar-fill" :style="{ width: dispositivoAlerta.porcentaje + '%' }"></div>
            </div>
            <span>{{ dispositivoAlerta.porcentaje }}% del tráfico total</span>
          </div>
          <div class="estado-upstream" :class="etiquetaEstado.clase">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span>Estado: {{ etiquetaEstado.texto }}</span>
          </div>
        </div>

        <!-- Ranking Top 5 -->
        <div class="ranking-card">
          <h3>
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            Ranking de actividad (Top 5)
          </h3>
          <ul class="ranking-list">
            <li
              v-for="([id, count], idx) in dispositivoAlerta.rankingCompleto"
              :key="id"
              :class="{ 'ranking-top': idx === 0 }"
            >
              <span class="rank-pos">{{ idx + 1 }}</span>
              <span class="rank-id">{{ id }}</span>
              <span class="rank-count">{{ count.toLocaleString() }}</span>
              <div class="rank-bar">
                <div class="rank-bar-fill" :style="{ width: Math.round((count / dispositivoAlerta.rankingCompleto[0][1]) * 100) + '%' }"></div>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════════════════════════════
         SECCIÓN DE GRÁFICAS DE SENSORES EN TIEMPO REAL
    ════════════════════════════════════════════════ -->
    <section class="graficas-section">
      <div class="graficas-header">
        <h2>
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          Gráficas de Sensores en Tiempo Real
        </h2>
        <span class="badge-pill badge-live">
          <span class="live-dot"></span>
          LIVE
        </span>
      </div>
      <!-- Leyenda de sensores -->
      <div class="sensor-legend">
        <div class="legend-item" v-for="(s, i) in [
          { label: CONFIG.SENSORES.LABEL_S1, color: CONFIG.SENSORES.COLOR_S1, dash: 'solid' },
          { label: CONFIG.SENSORES.LABEL_S2, color: CONFIG.SENSORES.COLOR_S2, dash: 'dashed' },
          { label: CONFIG.SENSORES.LABEL_S3, color: CONFIG.SENSORES.COLOR_S3, dash: 'dotted' },
        ]" :key="i">
          <span class="legend-line" :style="{ background: s.color, borderBottom: `2px ${s.dash} ${s.color}` }"></span>
          <span>{{ s.label }}</span>
        </div>
      </div>

      <!-- Grid de 3 gráficas -->
      <div class="graficas-grid">

        <!-- Gráfica 1: Línea — sensores en el tiempo -->
        <div class="grafica-card grafica-linea">
          <div class="grafica-titulo">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            Sensores — Historial de tiempo real
          </div>
          <div class="grafica-canvas-wrapper" style="height: 260px">
            <canvas id="chartLinea" role="img" aria-label="Gráfica de línea con historial de temperatura, humedad y presión en tiempo real">Sin datos aún</canvas>
          </div>
        </div>

        <!-- Gráfica 2: Barras — registros por dispositivo -->
        <div class="grafica-card">
          <div class="grafica-titulo">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            Registros por dispositivo
          </div>
          <div class="grafica-canvas-wrapper" style="height: 220px">
            <canvas id="chartBarras" role="img" aria-label="Gráfica de barras con conteo de registros por dispositivo Arduino">Sin datos aún</canvas>
          </div>
        </div>

        <!-- Gráfica 3: Dona — distribución de tráfico -->
        <div class="grafica-card">
          <div class="grafica-titulo">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>
            Distribución de tráfico
          </div>
          <div class="grafica-dona-layout">
            <div class="grafica-canvas-wrapper" style="height: 180px; width: 180px; flex-shrink: 0">
              <canvas id="chartDona" role="img" aria-label="Gráfica de dona mostrando distribución porcentual de tráfico por dispositivo">Sin datos aún</canvas>
            </div>
            <!-- Leyenda dinámica de la dona -->
            <ul class="dona-legend" v-if="dispositivoAlerta?.rankingCompleto?.length">
              <li
                v-for="([id, count], idx) in dispositivoAlerta.rankingCompleto"
                :key="id"
              >
                <span class="dona-dot" :style="{ background: PALETA[idx % PALETA.length] }"></span>
                <span class="dona-id">#{{ id }}</span>
                <span class="dona-count">{{ count.toLocaleString() }}</span>
              </li>
            </ul>
            <p v-else class="dona-empty">Cargando datos…</p>
          </div>
        </div>

      </div>
    </section>

    <!-- ── Inventario de Dispositivos ── -->
    <section class="inventario-section">
      <div class="inventario-header">
        <h2>
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h16M4 14h16M4 6h16M4 18h16"/></svg>
          Inventario de Dispositivos Conectados
        </h2>
        <div class="inventario-stats">
          <span class="badge-pill">Total: {{ totalInventario }}</span>
          <span class="badge-pill tag-activo">Activos: {{ activosInventario }}</span>
          <span class="badge-pill tag-inactivo">Inactivos: {{ inactivosInventario }}</span>
        </div>
      </div>
      
      <div class="inventario-grid">
        <div v-for="(estado, id) in estadosDispositivos" :key="id" class="device-card" :class="{ 'device-inactivo': !estado.activo }">
          <div class="device-card-header">
            <span class="device-dot" :class="estado.activo ? 'dot-activo' : 'dot-inactivo'"></span>
            <span class="device-id-text">{{ id }}</span>
          </div>
          <div class="device-card-status" :class="estado.activo ? 'text-activo' : 'text-inactivo'">
            {{ estado.activo ? 'Activo' : 'Inactivo' }}
          </div>
        </div>
        <div v-if="totalInventario === 0" class="empty-state">
          No hay dispositivos detectados en el sistema.
        </div>
      </div>
    </section>

    <!-- ── Tabla de últimos registros ── -->
    <section class="historial-section">
      <div class="historial-header">
        <h2>
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
          Historial de Registros en Mongo Atlas
        </h2>
        <div class="historial-meta">
          <span v-if="estadoTabla === 'ok'" class="badge-pill badge-count">{{ registros.length }} registros</span>
          <span v-if="ultimaActTabla" class="badge-pill">
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            {{ ultimaActTabla }}
          </span>
          <span class="badge-pill badge-live"><span class="live-dot"></span>LIVE</span>
        </div>
      </div>

      <div v-if="estadoTabla === 'cargando'" class="tabla-estado">
        <div class="spinner spinner-sm"></div><span>Cargando registros…</span>
      </div>
      <div v-else-if="estadoTabla === 'error'" class="tabla-estado tabla-error">
        <span>{{ errorTabla }}</span>
        <button class="btn-retry btn-retry-sm" @click="fetchTodos">Reintentar</button>
      </div>
      <div v-else-if="estadoTabla === 'sin-datos'" class="tabla-estado"><span>No hay registros disponibles.</span></div>

      <div v-else-if="estadoTabla === 'ok'" class="tabla-wrapper">
        <table class="registros-tabla">
          <thead>
            <tr>
              <th>{{ CONFIG.ETIQUETAS_TABLA.ID_REGISTRO }}</th>
              <th>{{ CONFIG.ETIQUETAS_TABLA.DEVICE_ID }}</th>
              <th>{{ CONFIG.ETIQUETAS_TABLA.VALOR }}</th>
              <th>{{ CONFIG.ETIQUETAS_TABLA.FECHA }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(item, idx) in registros"
              :key="getCampo(item, 'ID_REGISTRO') + idx"
              :class="{ 'row-highlight': String(getCampo(item, 'DEVICE_ID')) === String(dispositivoAlerta?.id) }"
            >
              <td class="col-id">{{ getCampo(item, 'ID_REGISTRO') }}</td>
              <td class="col-device">
                <span class="chip-device" :class="{ 'chip-top': String(getCampo(item, 'DEVICE_ID')) === String(dispositivoAlerta?.id) }">
                  {{ getCampo(item, 'DEVICE_ID') }}
                </span>
              </td>
              <td class="col-valor">{{ getCampo(item, 'VALOR') }}</td>
              <td class="col-fecha">{{ getCampo(item, 'FECHA') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── Footer ─────────────────────────────────── -->
    <footer class="monitor-footer">
      <span>API Top: <code>{{ CONFIG.URL_API_TOP }}</code></span>
      <span>API Todos: <code>{{ CONFIG.URL_API_TODOS }}</code></span>
      <span>Polling: <code>{{ CONFIG.POLLING_INTERVAL_MS / 1000 }}s</code></span>
    </footer>

  </div>
</template>

<style scoped>
/* ── Variables ── */
.monitor-container {
  --clr-bg:        #0d0f14;
  --clr-surface:   #13161e;
  --clr-surface-2: #1a1e2a;
  --clr-border:    #252a38;
  --clr-text:      #e4e8f0;
  --clr-muted:     #7a8299;
  --clr-accent:    #6c8efb;
  --clr-critico:   #ff4757;
  --clr-alto:      #ff6b35;
  --clr-medio:     #ffd93d;
  --clr-success:   #2ed573;
  --radius:        16px;
  --radius-sm:     10px;
  --shadow:        0 8px 32px rgba(0,0,0,.4);

  min-height: 100vh;
  background: var(--clr-bg);
  color: var(--clr-text);
  font-family: 'Inter', 'Segoe UI', sans-serif;
  display: flex;
  flex-direction: column;
}

/* ── Header ── */
.monitor-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 32px;
  background: var(--clr-surface);
  border-bottom: 1px solid var(--clr-border);
  position: sticky; top: 0; z-index: 10;
}
.header-left  { display: flex; align-items: center; gap: 12px; }
.header-left h1 {
  font-size: 1.2rem; font-weight: 700; margin: 0;
  background: linear-gradient(135deg, #fff 0%, var(--clr-accent) 100%);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
}
.pulse-dot {
  width: 11px; height: 11px; border-radius: 50%;
  background: var(--clr-muted); flex-shrink: 0; transition: background .3s;
}
.pulse-dot.active { background: var(--clr-success); animation: pulse-ring 2s infinite; }
@keyframes pulse-ring {
  0%   { box-shadow: 0 0 0 0   rgba(46,213,115,.4); }
  70%  { box-shadow: 0 0 0 10px rgba(46,213,115,0); }
  100% { box-shadow: 0 0 0 0   rgba(46,213,115,0);  }
}
.header-right { display: flex; gap: 10px; align-items: center; }
.badge-pill {
  display: flex; align-items: center; gap: 5px;
  font-size: .72rem; color: var(--clr-muted);
  background: var(--clr-surface-2); border: 1px solid var(--clr-border);
  padding: 4px 10px; border-radius: 20px;
}

/* ── Body ── */
.monitor-body { padding: 28px 32px 8px; display: flex; justify-content: center; }
.estado-card {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 48px 40px; background: var(--clr-surface);
  border: 1px solid var(--clr-border); border-radius: var(--radius);
  max-width: 480px; width: 100%; text-align: center;
}
.estado-icon { font-size: 3rem; }
.estado-card h2 { font-size: 1.2rem; font-weight: 700; margin: 0; }
.estado-card p  { margin: 0; color: var(--clr-muted); font-size: .875rem; }
.estado-error   { border-color: rgba(255,71,87,.3); }
.estado-error h2 { color: var(--clr-critico); }
.spinner { width: 38px; height: 38px; border: 3px solid var(--clr-border); border-top-color: var(--clr-accent); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.btn-retry { margin-top: 6px; padding: 9px 22px; background: transparent; border: 1px solid var(--clr-critico); color: var(--clr-critico); border-radius: var(--radius-sm); cursor: pointer; font-size: .85rem; font-weight: 600; transition: all .2s; }
.btn-retry:hover { background: var(--clr-critico); color: #fff; }

.alerta-wrapper { display: grid; grid-template-columns: 1fr 360px; gap: 22px; max-width: 1100px; width: 100%; }
@media (max-width: 860px) { .alerta-wrapper { grid-template-columns: 1fr; } }

.alerta-card {
  background: var(--clr-surface); border-radius: var(--radius); padding: 28px;
  display: flex; flex-direction: column; gap: 22px;
  box-shadow: var(--shadow); position: relative; overflow: hidden;
  border: 1px solid var(--clr-border); animation: slideUp .4s ease;
}
@keyframes slideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
.alerta-card::before { content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: var(--radius); opacity: .12; }
.alerta-card.nivel-inactivo { border-color: rgba(122,130,153,.3); }
.alerta-card.nivel-inactivo::before { background: radial-gradient(ellipse at top left, var(--clr-muted), transparent 70%); opacity: .05; }
.alerta-card.nivel-critico { border-color: rgba(255,71,87,.5); }
.alerta-card.nivel-critico::before { background: radial-gradient(ellipse at top left, var(--clr-critico), transparent 70%); }
.alerta-card.nivel-alto { border-color: rgba(255,107,53,.4); }
.alerta-card.nivel-alto::before { background: radial-gradient(ellipse at top left, var(--clr-alto), transparent 70%); opacity: .1; }
.alerta-card.nivel-medio { border-color: rgba(255,217,61,.25); }
.alerta-badge { font-size: .78rem; font-weight: 700; letter-spacing: .5px; }
.alerta-titulo { display: flex; align-items: center; gap: 10px; font-size: 1rem; font-weight: 600; }
.nivel-critico .alerta-titulo svg { stroke: var(--clr-critico); }
.nivel-alto    .alerta-titulo svg { stroke: var(--clr-alto); }
.nivel-medio   .alerta-titulo svg { stroke: var(--clr-medio); }
.alerta-device-id { display: flex; flex-direction: column; gap: 7px; }
.alerta-device-id label { font-size: .72rem; text-transform: uppercase; letter-spacing: 1px; color: var(--clr-muted); }
.device-id-value { display: flex; align-items: center; gap: 10px; background: var(--clr-surface-2); border: 1px solid var(--clr-border); border-radius: var(--radius-sm); padding: 12px 16px; }
.nivel-critico .device-id-value { border-color: rgba(255,71,87,.4); }
.nivel-alto    .device-id-value { border-color: rgba(255,107,53,.4); }
.device-id-value strong { font-size: 1.5rem; font-weight: 800; font-family: 'Courier New', monospace; letter-spacing: 2px; }
.nivel-inactivo .device-id-value strong { color: var(--clr-text); opacity: 0.6; }
.nivel-critico .device-id-value strong { color: var(--clr-critico); }
.nivel-alto    .device-id-value strong { color: var(--clr-alto); }
.nivel-medio   .device-id-value strong { color: var(--clr-medio); }
.nivel-inactivo .device-id-value svg { stroke: var(--clr-muted); }
.nivel-critico .device-id-value svg { stroke: var(--clr-critico); }
.nivel-alto    .device-id-value svg { stroke: var(--clr-alto); }
.nivel-medio   .device-id-value svg { stroke: var(--clr-medio); }
.alerta-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.stat-item { background: var(--clr-surface-2); border: 1px solid var(--clr-border); border-radius: var(--radius-sm); padding: 14px; display: flex; flex-direction: column; gap: 5px; }
.stat-label { font-size: .7rem; text-transform: uppercase; letter-spacing: .8px; color: var(--clr-muted); }
.stat-value { font-size: 1.9rem; font-weight: 800; line-height: 1; }
.nivel-inactivo .stat-value { color: var(--clr-muted); }
.nivel-critico .stat-value { color: var(--clr-critico); }
.nivel-alto    .stat-value { color: var(--clr-alto); }
.nivel-medio   .stat-value { color: var(--clr-medio); }
.progress-bar-wrapper { display: flex; flex-direction: column; gap: 5px; font-size: .75rem; color: var(--clr-muted); }
.progress-bar-track { height: 7px; background: var(--clr-surface-2); border-radius: 99px; overflow: hidden; }
.progress-bar-fill { height: 100%; border-radius: 99px; transition: width .6s ease; }
.nivel-inactivo .progress-bar-fill { background: var(--clr-muted); opacity: 0.5; }
.nivel-critico .progress-bar-fill { background: linear-gradient(90deg, var(--clr-critico), #ff8c00); }
.nivel-alto    .progress-bar-fill { background: linear-gradient(90deg, var(--clr-alto), var(--clr-critico)); }
.nivel-medio   .progress-bar-fill { background: linear-gradient(90deg, var(--clr-medio), #ff9f43); }
.estado-upstream {
  margin-top: 10px; padding: 12px 18px; border-radius: var(--radius-sm);
  display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: .88rem;
  border: 1px solid transparent;
}
.tag-inactivo { color: var(--clr-muted); background: rgba(122,130,153,.1); border-color: rgba(122,130,153,.2); }
.tag-critico { color: var(--clr-critico); background: rgba(255,71,87,.1); border-color: rgba(255,71,87,.2); }
.tag-critico svg { stroke: var(--clr-critico); }
.tag-alto    { background: rgba(255,107,53,.1); border-color: rgba(255,107,53,.35); color: #ffb39a; }
.tag-alto svg { stroke: var(--clr-alto); }
.tag-medio   { background: rgba(255,217,61,.08); border-color: rgba(255,217,61,.25); color: #ffe98a; }
.tag-medio svg { stroke: var(--clr-medio); }

.ranking-card { background: var(--clr-surface); border: 1px solid var(--clr-border); border-radius: var(--radius); padding: 22px; box-shadow: var(--shadow); animation: slideUp .4s ease .08s both; }
.ranking-card h3 { display: flex; align-items: center; gap: 7px; font-size: .82rem; font-weight: 700; text-transform: uppercase; letter-spacing: .8px; color: var(--clr-muted); margin: 0 0 18px; }
.ranking-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 11px; }
.ranking-list li { display: grid; grid-template-columns: 24px 1fr auto; grid-template-rows: auto 5px; gap: 3px 8px; align-items: center; }
.rank-pos  { font-size: .78rem; font-weight: 700; color: var(--clr-muted); text-align: center; }
.ranking-top .rank-pos { color: var(--clr-critico); }
.rank-id   { font-size: .83rem; font-weight: 600; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rank-count { font-size: .78rem; font-weight: 700; color: var(--clr-muted); }
.ranking-top .rank-count { color: var(--clr-critico); }
.rank-bar { grid-column: 1/-1; height: 4px; background: var(--clr-surface-2); border-radius: 99px; overflow: hidden; }
.rank-bar-fill { height: 100%; background: var(--clr-accent); border-radius: 99px; transition: width .6s ease; }
.ranking-top .rank-bar-fill { background: var(--clr-critico); }

/* ══════════════════════════════════════════════════
   GRÁFICAS — Sección nueva
══════════════════════════════════════════════════ */
.graficas-section {
  margin: 20px 32px 0;
  display: flex; flex-direction: column; gap: 18px;
}

.graficas-header {
  display: flex; align-items: center; justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--clr-border);
}
.graficas-header h2 {
  display: flex; align-items: center; gap: 9px;
  font-size: .95rem; font-weight: 700; margin: 0; color: var(--clr-text);
}
.graficas-header h2 svg { stroke: var(--clr-accent); }

/* Tarjetas métricas de sensores */
.sensor-metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
}
@media (max-width: 900px) { .sensor-metrics { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 500px) { .sensor-metrics { grid-template-columns: 1fr; } }

.sensor-metric-card {
  background: var(--clr-surface);
  border: 1px solid var(--clr-border);
  border-radius: var(--radius-sm);
  padding: 16px 18px;
  display: flex; flex-direction: column; gap: 8px;
  border-top: 3px solid var(--accent, #6c8efb);
  transition: border-color .3s;
}
.metric-header {
  display: flex; align-items: center; gap: 8px;
  font-size: .72rem; text-transform: uppercase; letter-spacing: .9px; color: var(--clr-muted);
}
.metric-header svg { stroke: var(--accent, #6c8efb); flex-shrink: 0; }
.metric-value {
  font-size: 2rem; font-weight: 800; line-height: 1;
  color: var(--accent, #6c8efb);
  display: flex; align-items: baseline; gap: 4px;
}
.metric-unit { font-size: .9rem; font-weight: 400; color: var(--clr-muted); }
.metric-sparkline {
  border: 1px solid;
  border-radius: 6px; padding: 5px 10px;
}
.metric-trend { font-size: .68rem; color: var(--clr-muted); }

/* Leyenda de líneas */
.sensor-legend {
  display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
  font-size: .76rem; color: var(--clr-muted);
  padding: 10px 14px;
  background: var(--clr-surface-2);
  border: 1px solid var(--clr-border);
  border-radius: var(--radius-sm);
}
.legend-item { display: flex; align-items: center; gap: 8px; }
.legend-line {
  display: inline-block; width: 26px; height: 2px;
  border-radius: 2px;
}

/* Grid de gráficas */
.graficas-grid {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  gap: 18px;
}
@media (max-width: 1000px) { .graficas-grid { grid-template-columns: 1fr 1fr; } }
@media (max-width: 640px)  { .graficas-grid { grid-template-columns: 1fr; } }

.grafica-card {
  background: var(--clr-surface);
  border: 1px solid var(--clr-border);
  border-radius: var(--radius);
  padding: 18px 20px 20px;
  display: flex; flex-direction: column; gap: 14px;
  box-shadow: var(--shadow);
}
.grafica-linea {
  grid-column: 1;
}
.grafica-titulo {
  display: flex; align-items: center; gap: 7px;
  font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .8px; color: var(--clr-muted);
}
.grafica-titulo svg { stroke: var(--clr-accent); }

.grafica-canvas-wrapper {
  position: relative; width: 100%;
}

/* Layout especial de la dona */
.grafica-dona-layout {
  display: flex; align-items: center; gap: 18px;
  flex-wrap: wrap;
}
.dona-legend {
  list-style: none; padding: 0; margin: 0;
  display: flex; flex-direction: column; gap: 8px; flex: 1; min-width: 100px;
}
.dona-legend li {
  display: flex; align-items: center; gap: 8px;
  font-size: .75rem;
}
.dona-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.dona-id  { font-family: monospace; font-weight: 600; color: var(--clr-text); flex: 1; }
.dona-count { color: var(--clr-muted); font-size: .7rem; }
.dona-empty { font-size: .8rem; color: var(--clr-muted); margin: 0; }

/* ── Historial ── */
.historial-section {
  margin: 20px 32px 0;
  background: var(--clr-surface); border: 1px solid var(--clr-border);
  border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow);
}
.historial-header {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;
  padding: 18px 24px; border-bottom: 1px solid var(--clr-border);
  background: var(--clr-surface-2);
}
.historial-header h2 { display: flex; align-items: center; gap: 9px; font-size: .95rem; font-weight: 700; margin: 0; color: var(--clr-text); }
.historial-header h2 svg { stroke: var(--clr-accent); }
.historial-meta { display: flex; align-items: center; gap: 8px; }
.badge-count { background: rgba(108,142,251,.12); border-color: rgba(108,142,251,.3); color: var(--clr-accent); }
.badge-live  { display: flex; align-items: center; gap: 5px; font-size: .65rem; font-weight: 700; letter-spacing: 1px; color: var(--clr-success); background: rgba(46,213,115,.08); border-color: rgba(46,213,115,.3) !important; }
.live-dot    { width: 6px; height: 6px; border-radius: 50%; background: var(--clr-success); animation: pulse-ring 2s infinite; }

.tabla-estado { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 40px 24px; color: var(--clr-muted); font-size: .875rem; }
.spinner-sm   { width: 22px; height: 22px; border: 2px solid var(--clr-border); border-top-color: var(--clr-accent); border-radius: 50%; animation: spin .8s linear infinite; flex-shrink: 0; }
.tabla-error  { color: #ff8a94; }
.btn-retry-sm { padding: 5px 14px; border: 1px solid var(--clr-critico); color: var(--clr-critico); background: transparent; border-radius: 6px; cursor: pointer; font-size: .8rem; font-weight: 600; transition: all .2s; }
.btn-retry-sm:hover { background: var(--clr-critico); color: #fff; }

.tabla-wrapper {
  max-height: v-bind("`${CONFIG.MAX_FILAS_VISIBLES * 44}px`");
  overflow-y: auto;
  scrollbar-width: thin; scrollbar-color: var(--clr-border) transparent;
}
.tabla-wrapper::-webkit-scrollbar { width: 5px; }
.tabla-wrapper::-webkit-scrollbar-track { background: transparent; }
.tabla-wrapper::-webkit-scrollbar-thumb { background: var(--clr-border); border-radius: 3px; }
.tabla-wrapper::-webkit-scrollbar-thumb:hover { background: var(--clr-accent); }

.registros-tabla { width: 100%; border-collapse: collapse; font-size: .82rem; }
.registros-tabla thead { position: sticky; top: 0; z-index: 2; background: var(--clr-surface-2); }
.registros-tabla th { padding: 10px 16px; text-align: left; font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .9px; color: var(--clr-muted); border-bottom: 1px solid var(--clr-border); white-space: nowrap; }
.registros-tabla td { padding: 10px 16px; border-bottom: 1px solid rgba(37,42,56,.6); color: var(--clr-text); vertical-align: middle; }
.registros-tabla tbody tr { transition: background .15s; }
.registros-tabla tbody tr:hover { background: var(--clr-surface-2); }
.row-highlight td { background: rgba(255,71,87,.05); }
.row-highlight:hover td { background: rgba(255,71,87,.1) !important; }
.col-id     { font-family: monospace; color: var(--clr-muted); width: 60px; }
.col-device { width: 120px; }
.col-valor  { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-fecha  { color: var(--clr-muted); font-size: .75rem; white-space: nowrap; }
.chip-device { display: inline-block; padding: 2px 9px; border-radius: 20px; font-family: monospace; font-size: .78rem; font-weight: 600; background: var(--clr-surface-2); border: 1px solid var(--clr-border); color: var(--clr-muted); }
.chip-top    { background: rgba(255,71,87,.12); border-color: rgba(255,71,87,.35); color: #ff8a94; }

/* ── Footer ── */
.monitor-footer {
  display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
  margin-top: 20px; padding: 13px 32px;
  border-top: 1px solid var(--clr-border);
  font-size: .7rem; color: var(--clr-muted);
  background: var(--clr-surface);
}
.monitor-footer code { background: var(--clr-surface-2); padding: 2px 7px; border-radius: 4px; font-size: .68rem; color: var(--clr-accent); }
</style>