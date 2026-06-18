<script setup>
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { Chart, registerables } from 'chart.js'
Chart.register(...registerables)

// ============================================================
//  CONFIGURACIÓN — Edita aquí tus parámetros
// ============================================================
const CONFIG = {
  URL_API_DATOS:        import.meta.env.VITE_API_URL_DATOS        || 'http://localhost:3001/api/datos?collection=processed_readings&limit=500',
  URL_API_DISPOSITIVOS: import.meta.env.VITE_API_URL_DISPOSITIVOS || 'http://localhost:3001/api/dispositivos?collection=processed_readings',
  POLLING_INTERVAL_MS: 5000,
  INACTIVO_UMBRAL_MS:  120_000,

  CAMPOS_TOP: {
    DEVICE_ID: 'DeviceCode',
    COUNT: null,
  },

  CAMPOS_REGISTROS: {
    ID_REGISTRO: 'Id',
    DEVICE_ID:   'DeviceCode',
    VALOR:       'Value',
    FECHA:       'Timestamp',
  },

  SENSORES: {
    CAMPO_S1:  'Value',
    FILTER_S1: 'temperature',
    LABEL_S1:  'Temperatura',
    UNIDAD_S1: '°C',
    COLOR_S1:  '#ff4757',

    CAMPO_S2:  'Value',
    FILTER_S2: 'humidity',
    LABEL_S2:  'Humedad',
    UNIDAD_S2: '%',
    COLOR_S2:  '#6c8efb',

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

// ── Canvas refs (reemplaza document.getElementById) ──
const chartLineaRef  = ref(null)
const chartBarrasRef = ref(null)
const chartDonaRef   = ref(null)

let chartLinea  = null
let chartBarras = null
let chartDona   = null
let intervalo   = null

// ────────────────────────────────────────────────────────────
//  FETCH ÚNICO: tabla + ranking + gráficas en una sola petición
// ────────────────────────────────────────────────────────────
async function fetchDatos() {
  if (estadoTop.value === 'idle')   estadoTop.value   = 'cargando'
  if (estadoTabla.value === 'idle') estadoTabla.value = 'cargando'
  try {
    const res = await fetch(CONFIG.URL_API_DATOS)
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`)
    const data = await res.json()
    const lista = Array.isArray(data) ? data : data?.results ?? data?.data ?? []

    registros.value      = lista
    estadoTabla.value    = lista.length ? 'ok' : 'sin-datos'
    ultimaActTabla.value = new Date().toLocaleTimeString('es-MX')

    if (!lista.length) {
      estadoTop.value = 'sin-datos'
      dispositivoAlerta.value = null
      return
    }

    const conteo = {}
    lista.forEach(item => {
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
    estadoTop.value    = 'ok'
    ultimaActTop.value = new Date().toLocaleTimeString('es-MX')
    actualizarDatosSensores(lista)
  } catch (err) {
    const msg = err.message ?? 'Error desconocido'
    estadoTop.value = 'error'; errorTop.value = msg
    estadoTabla.value = 'error'; errorTabla.value = msg
  }
}

// ────────────────────────────────────────────────────────────
//  FETCH INVENTARIO: todos los dispositivos vía agregación
//  Garantiza que aparezcan TODOS aunque no estén en los últimos
//  500 registros. Falla silenciosamente (sección no crítica).
// ────────────────────────────────────────────────────────────
async function fetchDispositivos() {
  try {
    const res = await fetch(CONFIG.URL_API_DISPOSITIVOS)
    if (!res.ok) return
    const lista = await res.json()
    const ahora = Date.now()
    const nuevoEstado = {}
    lista.forEach(d => {
      const id     = d.DeviceCode ?? d.deviceCode ?? d._id
      const lastTs = d.lastTimestamp ? new Date(d.lastTimestamp).getTime() : 0
      nuevoEstado[id] = {
        activo:    (ahora - lastTs) < CONFIG.INACTIVO_UMBRAL_MS,
        registros: d.count ?? 0,
      }
    })
    estadosDispositivos.value = nuevoEstado
  } catch { /* inventario no crítico */ }
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
  if (chartLineaRef.value) {
    chartLinea = new Chart(chartLineaRef.value, {
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
  if (chartBarrasRef.value) {
    chartBarras = new Chart(chartBarrasRef.value, {
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
  if (chartDonaRef.value) {
    chartDona = new Chart(chartDonaRef.value, {
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
  await Promise.all([fetchDatos(), fetchDispositivos()])
}

// ── Computeds de Inventario ──
const totalInventario = computed(() => Object.keys(estadosDispositivos.value).length)
const activosInventario = computed(() => Object.values(estadosDispositivos.value).filter(s => s.activo).length)
const inactivosInventario = computed(() => totalInventario.value - activosInventario.value)

// ── Nivel de alerta (para compatibilidad con ranking/dona) ──
const nivelAlerta = computed(() => {
  const p = dispositivoAlerta.value?.porcentaje ?? 0
  if (p >= 70) return 'critico'
  if (p >= 40) return 'alto'
  return 'medio'
})

// Último valor de cada sensor (para las tarjetas métricas)
const ultimoS1 = computed(() => historialS1.value[historialS1.value.length - 1] ?? '—')
const ultimoS2 = computed(() => historialS2.value[historialS2.value.length - 1] ?? '—')
const ultimoS3 = computed(() => historialS3.value[historialS3.value.length - 1] ?? '—')

// ──────────────────────────────────────────────────────────────
//  GRID DE DISPOSITIVOS
//  Agrupa el array raw por DeviceCode y extrae el último valor
//  de cada tipo de sensor para mostrarlo en las cards.
// ──────────────────────────────────────────────────────────────
const SENSOR_DEFS = [
  { tipo: CONFIG.SENSORES.FILTER_S1, label: CONFIG.SENSORES.LABEL_S1, unidad: CONFIG.SENSORES.UNIDAD_S1, color: CONFIG.SENSORES.COLOR_S1, icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.31-8.86c-1.77-.45-2.34-.94-2.34-1.67 0-.84.79-1.43 2.1-1.43 1.38 0 1.9.66 1.94 1.64h1.71c-.05-1.34-.87-2.57-2.49-2.97V5H10.9v1.69c-1.51.32-2.72 1.3-2.72 2.81 0 1.79 1.48 2.68 3.66 3.19 1.95.46 2.34 1.15 2.34 1.86 0 .53-.39 1.38-2.1 1.38-1.6 0-2.23-.72-2.32-1.64H8.04c.1 1.7 1.37 2.66 2.86 2.97V19h2.34v-1.67c1.52-.29 2.72-1.16 2.73-2.77-.01-2.2-1.9-2.96-3.66-3.42z' },
  { tipo: CONFIG.SENSORES.FILTER_S2, label: CONFIG.SENSORES.LABEL_S2, unidad: CONFIG.SENSORES.UNIDAD_S2, color: CONFIG.SENSORES.COLOR_S2, icon: 'M12 2a5 5 0 0 1 5 5v6a5 5 0 0 1-10 0V7a5 5 0 0 1 5-5zm0 15a7 7 0 0 0 7-7H5a7 7 0 0 0 7 7zm0 2v2m-3 0h6' },
  { tipo: CONFIG.SENSORES.FILTER_S3, label: CONFIG.SENSORES.LABEL_S3, unidad: CONFIG.SENSORES.UNIDAD_S3, color: CONFIG.SENSORES.COLOR_S3, icon: 'M2 12h20M12 2v20M4.93 4.93l14.14 14.14M19.07 4.93 4.93 19.07' },
]

const dispositivosGrid = computed(() => {
  const ahora = Date.now()

  // Fase 1: extraer valores de sensores y último timestamp de los últimos N registros
  const mapa = {}
  registros.value.forEach(item => {
    const dId        = item[CONFIG.CAMPOS_REGISTROS.DEVICE_ID] ?? 'desconocido'
    const sensorType = (item.SensorType ?? '').toLowerCase()
    const value      = parseFloat(item[CONFIG.CAMPOS_REGISTROS.VALOR])

    if (!mapa[dId]) {
      mapa[dId] = { id: dId, lastTs: 0, ultimaActualizacion: null, sensores: {} }
    }
    if (sensorType && !isNaN(value)) mapa[dId].sensores[sensorType] = value

    const raw = item[CONFIG.CAMPOS_REGISTROS.FECHA]
    if (raw) {
      const ts = new Date(raw).getTime()
      if (ts > mapa[dId].lastTs) { mapa[dId].lastTs = ts; mapa[dId].ultimaActualizacion = raw }
    }
  })

  // Fase 2: fusionar con el inventario de agregación (conteos reales + TODOS los dispositivos)
  // Esto garantiza que aparezcan dispositivos que no cayeron en los últimos N registros
  const inventario = estadosDispositivos.value
  const todosIds   = new Set([...Object.keys(mapa), ...Object.keys(inventario)])

  return Array.from(todosIds).map(id => {
    const local = mapa[id] ?? { id, lastTs: 0, ultimaActualizacion: null, sensores: {} }
    const agg   = inventario[id]
    return {
      id,
      registros:          agg?.registros ?? 0,   // total real desde MongoDB (no solo los últimos N)
      activo:             agg?.activo ?? (local.lastTs ? (ahora - local.lastTs) < CONFIG.INACTIVO_UMBRAL_MS : false),
      ultimaActualizacion: local.ultimaActualizacion,
      sensores:           local.sensores,
    }
  }).sort((a, b) => b.registros - a.registros)
})

// Formatea el timestamp para mostrarlo en la card
function formatTimestamp(ts) {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch { return ts }
}

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

    <!-- ══════════════════════════════════════════════════
         GRID DE DISPOSITIVOS CONECTADOS
    ═══════════════════════════════════════════════════ -->
    <section class="devices-section">
      <!-- Header de la sección -->
      <div class="devices-section-header">
        <div class="devices-section-title">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
          <h2>Dispositivos Conectados</h2>
        </div>
        <div class="devices-section-meta">
          <span class="badge-pill badge-live"><span class="live-dot"></span>LIVE</span>
          <span class="badge-pill">Total: {{ dispositivosGrid.length }}</span>
          <span class="badge-pill tag-activo-pill">Activos: {{ dispositivosGrid.filter(d => d.activo).length }}</span>
          <span v-if="ultimaActTabla" class="badge-pill">
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            {{ ultimaActTabla }}
          </span>
        </div>
      </div>

      <!-- Estado: cargando -->
      <div v-if="estadoTabla === 'idle' || estadoTabla === 'cargando'" class="devices-estado">
        <div class="spinner"></div>
        <span>Consultando dispositivos…</span>
      </div>

      <!-- Estado: error -->
      <div v-else-if="estadoTabla === 'error'" class="devices-estado devices-error">
        <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div>
          <p>Error de conexión</p>
          <small>{{ errorTabla }}</small>
        </div>
        <button class="btn-retry" @click="fetchDatos">Reintentar</button>
      </div>

      <!-- Estado: sin datos -->
      <div v-else-if="estadoTabla === 'sin-datos' || dispositivosGrid.length === 0" class="devices-estado">
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
        <span>No hay dispositivos detectados aún.</span>
      </div>

      <!-- GRID de cards -->
      <div v-else class="devices-grid">
        <div
          v-for="(dev, idx) in dispositivosGrid"
          :key="dev.id"
          class="dcard"
          :class="{ 'dcard--top': idx === 0, 'dcard--inactivo': !dev.activo }"
          :style="{ '--dcard-accent': PALETA[idx % PALETA.length] }"
        >
          <!-- Header de la card -->
          <div class="dcard__header">
            <div class="dcard__id-wrap">
              <span class="dcard__status-dot" :class="dev.activo ? 'dot--activo' : 'dot--inactivo'"></span>
              <span class="dcard__id">{{ dev.id }}</span>
              <span v-if="idx === 0" class="dcard__crown" title="Mayor actividad">👑</span>
            </div>
            <span class="dcard__badge" :class="dev.activo ? 'badge--activo' : 'badge--inactivo'">
              {{ dev.activo ? 'Activo' : 'Inactivo' }}
            </span>
          </div>

          <!-- Conteo de registros -->
          <div class="dcard__count">
            <span class="dcard__count-num">{{ dev.registros.toLocaleString() }}</span>
            <span class="dcard__count-label">registros</span>
          </div>

          <!-- Barra de actividad relativa -->
          <div class="dcard__progress">
            <div
              class="dcard__progress-fill"
              :style="{
                width: dispositivosGrid[0]?.registros
                  ? Math.round((dev.registros / dispositivosGrid[0].registros) * 100) + '%'
                  : '0%',
                background: PALETA[idx % PALETA.length]
              }"
            ></div>
          </div>

          <!-- Valores de sensores -->
          <div class="dcard__sensors">
            <div
              v-for="sensor in SENSOR_DEFS"
              :key="sensor.tipo"
              class="dcard__sensor-chip"
              :style="{ '--chip-color': sensor.color }"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path :d="sensor.icon"/>
              </svg>
              <span class="dcard__sensor-label">{{ sensor.label }}</span>
              <span class="dcard__sensor-val">
                {{ dev.sensores[sensor.tipo] != null ? dev.sensores[sensor.tipo] : '—' }}
                <em v-if="dev.sensores[sensor.tipo] != null">{{ sensor.unidad }}</em>
              </span>
            </div>
          </div>

          <!-- Timestamp última lectura -->
          <div class="dcard__footer">
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span>Última lectura: {{ formatTimestamp(dev.ultimaActualizacion) }}</span>
          </div>
        </div>
      </div>
    </section>

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
            <canvas ref="chartLineaRef" role="img" aria-label="Gráfica de línea con historial de temperatura, humedad y presión en tiempo real">Sin datos aún</canvas>
          </div>
        </div>

        <!-- Gráfica 2: Barras — registros por dispositivo -->
        <div class="grafica-card">
          <div class="grafica-titulo">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            Registros por dispositivo
          </div>
          <div class="grafica-canvas-wrapper" style="height: 220px">
            <canvas ref="chartBarrasRef" role="img" aria-label="Gráfica de barras con conteo de registros por dispositivo Arduino">Sin datos aún</canvas>
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
              <canvas ref="chartDonaRef" role="img" aria-label="Gráfica de dona mostrando distribución porcentual de tráfico por dispositivo">Sin datos aún</canvas>
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

    <!-- El inventario ahora está integrado en el Grid de Dispositivos de arriba -->

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
        <button class="btn-retry btn-retry-sm" @click="fetchDatos">Reintentar</button>
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
      <span>API Datos: <code>{{ CONFIG.URL_API_DATOS }}</code></span>
      <span>API Dispositivos: <code>{{ CONFIG.URL_API_DISPOSITIVOS }}</code></span>
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
   GRID DE DISPOSITIVOS
══════════════════════════════════════════════════ */
.devices-section {
  margin: 24px 32px 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.devices-section-header {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--clr-border);
}
.devices-section-title {
  display: flex; align-items: center; gap: 10px;
}
.devices-section-title svg { stroke: var(--clr-accent); }
.devices-section-title h2 {
  font-size: 1rem; font-weight: 700; margin: 0;
  background: linear-gradient(135deg, #fff 0%, var(--clr-accent) 100%);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
}
.devices-section-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tag-activo-pill { background: rgba(46,213,115,.08) !important; border-color: rgba(46,213,115,.3) !important; color: var(--clr-success) !important; }

/* Estado vacío / cargando / error */
.devices-estado {
  display: flex; align-items: center; justify-content: center; gap: 14px;
  padding: 52px 24px;
  background: var(--clr-surface);
  border: 1px solid var(--clr-border);
  border-radius: var(--radius);
  color: var(--clr-muted);
  font-size: .875rem;
  flex-direction: column;
  text-align: center;
}
.devices-estado svg { stroke: var(--clr-muted); opacity: .5; }
.devices-error { color: #ff8a94; }
.devices-error svg { stroke: var(--clr-critico); opacity: .8; }
.devices-error p { margin: 0; font-weight: 600; }
.devices-error small { color: var(--clr-muted); font-size: .78rem; }

/* Grid responsive */
.devices-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 18px;
}
@media (max-width: 640px) { .devices-grid { grid-template-columns: 1fr; } }

/* Device Card */
.dcard {
  --dcard-accent: #6c8efb;
  background: var(--clr-surface);
  border: 1px solid var(--clr-border);
  border-top: 3px solid var(--dcard-accent);
  border-radius: var(--radius);
  padding: 20px;
  display: flex; flex-direction: column; gap: 14px;
  box-shadow: var(--shadow);
  transition: transform .2s, box-shadow .2s, border-color .3s;
  animation: slideUp .35s ease both;
  position: relative; overflow: hidden;
}
.dcard::after {
  content: '';
  position: absolute; top: 0; left: 0; right: 0;
  height: 60px;
  background: linear-gradient(to bottom, color-mix(in srgb, var(--dcard-accent) 8%, transparent), transparent);
  pointer-events: none;
}
.dcard:hover {
  transform: translateY(-3px);
  box-shadow: 0 12px 40px rgba(0,0,0,.5);
  border-color: var(--dcard-accent);
}
.dcard--top {
  border-top-width: 3px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dcard-accent) 30%, transparent), var(--shadow);
}
.dcard--inactivo { opacity: .55; filter: grayscale(.4); }

/* Card Header */
.dcard__header {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.dcard__id-wrap {
  display: flex; align-items: center; gap: 8px; min-width: 0;
}
.dcard__status-dot {
  width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
}
.dot--activo   { background: var(--clr-success); box-shadow: 0 0 0 3px rgba(46,213,115,.2); animation: pulse-ring 2s infinite; }
.dot--inactivo { background: var(--clr-muted); }
.dcard__id {
  font-family: 'Courier New', monospace;
  font-size: .88rem; font-weight: 700;
  color: var(--dcard-accent);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dcard__crown { font-size: .9rem; flex-shrink: 0; }
.dcard__badge {
  font-size: .65rem; font-weight: 700; text-transform: uppercase; letter-spacing: .7px;
  padding: 3px 9px; border-radius: 20px; flex-shrink: 0;
}
.badge--activo   { background: rgba(46,213,115,.12); border: 1px solid rgba(46,213,115,.3); color: var(--clr-success); }
.badge--inactivo { background: rgba(122,130,153,.1); border: 1px solid rgba(122,130,153,.2); color: var(--clr-muted); }

/* Conteo */
.dcard__count {
  display: flex; align-items: baseline; gap: 6px;
}
.dcard__count-num {
  font-size: 2.2rem; font-weight: 800; line-height: 1;
  color: var(--dcard-accent);
}
.dcard__count-label {
  font-size: .72rem; text-transform: uppercase; letter-spacing: .8px; color: var(--clr-muted);
}

/* Barra de progreso relativa */
.dcard__progress {
  height: 5px;
  background: var(--clr-surface-2);
  border-radius: 99px;
  overflow: hidden;
}
.dcard__progress-fill {
  height: 100%;
  border-radius: 99px;
  transition: width .6s ease;
  opacity: .8;
}

/* Chips de sensores */
.dcard__sensors {
  display: flex; flex-direction: column; gap: 7px;
}
.dcard__sensor-chip {
  --chip-color: #6c8efb;
  display: flex; align-items: center; gap: 7px;
  background: var(--clr-surface-2);
  border: 1px solid var(--clr-border);
  border-left: 3px solid var(--chip-color);
  border-radius: 7px;
  padding: 7px 10px;
  font-size: .78rem;
  transition: border-color .2s;
}
.dcard__sensor-chip svg { stroke: var(--chip-color); flex-shrink: 0; }
.dcard__sensor-label { color: var(--clr-muted); flex: 1; text-transform: capitalize; }
.dcard__sensor-val {
  font-weight: 700; color: var(--clr-text);
  display: flex; align-items: baseline; gap: 2px;
}
.dcard__sensor-val em { font-style: normal; font-size: .68rem; color: var(--clr-muted); font-weight: 400; }

/* Footer timestamp */
.dcard__footer {
  display: flex; align-items: center; gap: 5px;
  font-size: .68rem; color: var(--clr-muted);
  border-top: 1px solid var(--clr-border);
  padding-top: 10px;
  margin-top: 2px;
}
.dcard__footer svg { stroke: var(--clr-muted); flex-shrink: 0; }

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