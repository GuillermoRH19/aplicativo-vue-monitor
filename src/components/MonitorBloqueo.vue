<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'

// ============================================================
//  CONFIGURACIÓN GENÉRICA — Edita aquí tus parámetros
// ============================================================
const CONFIG = {
  // ── Endpoint 1: Top de actividad (dispositivo con más registros) ──
  // Debe devolver un array de objetos agrupables por DEVICE_ID
  URL_API_TOP: 'https://jsonplaceholder.typicode.com/todos',

  // ── Endpoint 2: Lista completa de registros desde MongoDB Atlas ──
  // Debe devolver un array con los últimos registros guardados
  URL_API_TODOS: 'https://jsonplaceholder.typicode.com/posts',

  // Intervalo de polling en ms (ambas consultas se actualizan en paralelo)
  POLLING_INTERVAL_MS: 5000,

  // ── Mapeo de campos para el TOP de actividad ──
  CAMPOS_TOP: {
    // Campo que identifica al dispositivo/Arduino
    DEVICE_ID: 'userId',
    // Si tu API ya devuelve un conteo numérico, escríbelo aquí.
    // Pon null para que el componente lo calcule agrupando por DEVICE_ID.
    COUNT: null,
  },

  // ── Mapeo de campos para la tabla de registros ──
  // Ajusta cada clave al nombre real del campo en tu JSON de MongoDB
  CAMPOS_REGISTROS: {
    ID_REGISTRO: 'id',          // Identificador único del registro
    DEVICE_ID:   'userId',      // ID del dispositivo que generó el dato
    VALOR:       'title',       // Valor del sensor / dato principal
    FECHA:       null,          // Campo de fecha/hora; null = sin fecha en mock
  },

  // Número máximo de filas visibles en la tabla antes de hacer scroll
  MAX_FILAS_VISIBLES: 12,

  // Etiquetas de columna visibles en la tabla
  ETIQUETAS_TABLA: {
    ID_REGISTRO: '#',
    DEVICE_ID:   'Dispositivo',
    VALOR:       'Dato / Valor',
    FECHA:       'Fecha / Hora',
  },

  // Labels generales
  LABELS: {
    DEVICE: 'Dispositivo / Arduino',
    COUNT:  'Registros enviados',
  },
}
// ============================================================

// ── Estado reactivo: TOP de actividad ──
const estadoTop     = ref('idle') // 'idle' | 'cargando' | 'ok' | 'error' | 'sin-datos'
const errorTop      = ref('')
const dispositivoAlerta = ref(null)
const ultimaActTop  = ref(null)

// ── Estado reactivo: lista de registros ──
const estadoTabla   = ref('idle')
const errorTabla    = ref('')
const registros     = ref([])
const ultimaActTabla = ref(null)

// Contador de ciclos de polling
const contadorPoll  = ref(0)

let intervalo = null

// ── Fetch: top de actividad ──
async function fetchTop() {
  if (estadoTop.value === 'idle') estadoTop.value = 'cargando'
  try {
    const res = await fetch(CONFIG.URL_API_TOP)
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`)
    const data = await res.json()
    const lista = Array.isArray(data) ? data : data?.results ?? data?.data ?? []

    if (!lista.length) { estadoTop.value = 'sin-datos'; dispositivoAlerta.value = null; return }

    // Agrupar por DEVICE_ID
    const conteo = {}
    lista.forEach((item) => {
      const id = item[CONFIG.CAMPOS_TOP.DEVICE_ID] ?? 'desconocido'
      const val = CONFIG.CAMPOS_TOP.COUNT ? Number(item[CONFIG.CAMPOS_TOP.COUNT]) : 1
      conteo[id] = (conteo[id] ?? 0) + val
    })

    const [topId, topCount] = Object.entries(conteo).reduce(
      (max, entry) => (entry[1] > max[1] ? entry : max),
      ['', -Infinity],
    )

    dispositivoAlerta.value = {
      id: topId,
      count: topCount,
      porcentaje: Math.round((topCount / lista.length) * 100),
      rankingCompleto: Object.entries(conteo)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
    }
    estadoTop.value = 'ok'
    ultimaActTop.value = new Date().toLocaleTimeString('es-MX')
  } catch (err) {
    estadoTop.value = 'error'
    errorTop.value = err.message ?? 'Error desconocido'
    console.error('[MonitorBloqueo] Error fetchTop:', err)
  }
}

// ── Fetch: lista completa de registros ──
async function fetchTodos() {
  if (estadoTabla.value === 'idle') estadoTabla.value = 'cargando'
  try {
    const res = await fetch(CONFIG.URL_API_TODOS)
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`)
    const data = await res.json()
    const lista = Array.isArray(data) ? data : data?.results ?? data?.data ?? []
    registros.value = lista
    estadoTabla.value = lista.length ? 'ok' : 'sin-datos'
    ultimaActTabla.value = new Date().toLocaleTimeString('es-MX')
  } catch (err) {
    estadoTabla.value = 'error'
    errorTabla.value = err.message ?? 'Error desconocido'
    console.error('[MonitorBloqueo] Error fetchTodos:', err)
  }
}

// ── Polling paralelo ──
async function pollCiclo() {
  contadorPoll.value++
  await Promise.all([fetchTop(), fetchTodos()])
}

// ── Nivel de alerta según porcentaje ──
const nivelAlerta = computed(() => {
  const p = dispositivoAlerta.value?.porcentaje ?? 0
  if (p >= 70) return 'critico'
  if (p >= 40) return 'alto'
  return 'medio'
})

// ── Etiqueta de estado pasivo ──
const etiquetaEstado = computed(() => {
  const n = nivelAlerta.value
  if (n === 'critico') return { texto: 'Tráfico Excedido — Requiere Bloqueo Upstream', clase: 'tag-critico' }
  if (n === 'alto')    return { texto: 'Tráfico Elevado — Monitorear Upstream', clase: 'tag-alto' }
  return { texto: 'Tráfico Normal — Sin Acción Requerida', clase: 'tag-medio' }
})

// ── Valor de celda de la tabla con fallback ──
function getCampo(item, campo) {
  const key = CONFIG.CAMPOS_REGISTROS[campo]
  if (!key) return '—'
  const val = item[key]
  return val !== undefined && val !== null && val !== '' ? val : '—'
}

onMounted(() => {
  pollCiclo()
  intervalo = setInterval(pollCiclo, CONFIG.POLLING_INTERVAL_MS)
})

onUnmounted(() => {
  clearInterval(intervalo)
})
</script>

<template>
  <div class="monitor-container">

    <!-- ── Header ────────────────────────────────────── -->
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

    <!-- ── Body principal (dos tarjetas) ─────────────── -->
    <div class="monitor-body">

      <!-- Estado: Cargando inicial -->
      <div v-if="estadoTop === 'cargando'" class="estado-card estado-cargando">
        <div class="spinner"></div>
        <p>Consultando API…</p>
        <small>{{ CONFIG.URL_API_TOP }}</small>
      </div>

      <!-- Estado: Error -->
      <div v-else-if="estadoTop === 'error'" class="estado-card estado-error">
        <div class="estado-icon">⚠️</div>
        <h2>Error de conexión</h2>
        <p>{{ errorTop }}</p>
        <small>{{ CONFIG.URL_API_TOP }}</small>
        <button class="btn-retry" @click="fetchTop">Reintentar</button>
      </div>

      <!-- Estado: Sin datos -->
      <div v-else-if="estadoTop === 'sin-datos'" class="estado-card">
        <div class="estado-icon">📭</div>
        <h2>Sin datos disponibles</h2>
        <p>La API respondió pero no devolvió registros.</p>
      </div>

      <!-- Estado: OK ──────────────────────────────────── -->
      <div v-else-if="estadoTop === 'ok' && dispositivoAlerta" class="alerta-wrapper">

        <!-- Tarjeta principal de alerta -->
        <div class="alerta-card" :class="`nivel-${nivelAlerta}`">

          <!-- Badge de nivel -->
          <div class="alerta-badge">
            <span v-if="nivelAlerta === 'critico'">🔴 CRÍTICO</span>
            <span v-else-if="nivelAlerta === 'alto'">🟠 ALTO</span>
            <span v-else>🟡 MEDIO</span>
          </div>

          <!-- Título -->
          <div class="alerta-titulo">
            <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span>Dispositivo con mayor actividad detectado</span>
          </div>

          <!-- ID del dispositivo -->
          <div class="alerta-device-id">
            <label>{{ CONFIG.LABELS.DEVICE }}</label>
            <div class="device-id-value">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="7" width="6" height="10" rx="1"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/></svg>
              <strong>{{ dispositivoAlerta.id }}</strong>
            </div>
          </div>

          <!-- Stats numéricos -->
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

          <!-- Barra de progreso -->
          <div class="progress-bar-wrapper">
            <div class="progress-bar-track">
              <div class="progress-bar-fill" :style="{ width: dispositivoAlerta.porcentaje + '%' }"></div>
            </div>
            <span>{{ dispositivoAlerta.porcentaje }}% del tráfico total</span>
          </div>

          <!-- ✅ Etiqueta de estado PASIVO (sin botón de acción) -->
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
                <div
                  class="rank-bar-fill"
                  :style="{ width: Math.round((count / dispositivoAlerta.rankingCompleto[0][1]) * 100) + '%' }"
                ></div>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <!-- ── Sección: Historial completo de registros ─────── -->
    <section class="historial-section">
      <div class="historial-header">
        <h2>
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
          Historial de Registros en Mongo Atlas
        </h2>
        <div class="historial-meta">
          <span v-if="estadoTabla === 'ok'" class="badge-pill badge-count">
            {{ registros.length }} registros
          </span>
          <span v-if="ultimaActTabla" class="badge-pill">
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            {{ ultimaActTabla }}
          </span>
          <span class="badge-pill badge-live">
            <span class="live-dot"></span>
            LIVE
          </span>
        </div>
      </div>

      <!-- Cargando tabla -->
      <div v-if="estadoTabla === 'cargando'" class="tabla-estado">
        <div class="spinner spinner-sm"></div>
        <span>Cargando registros…</span>
      </div>

      <!-- Error tabla -->
      <div v-else-if="estadoTabla === 'error'" class="tabla-estado tabla-error">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>{{ errorTabla }}</span>
        <button class="btn-retry btn-retry-sm" @click="fetchTodos">Reintentar</button>
      </div>

      <!-- Sin datos tabla -->
      <div v-else-if="estadoTabla === 'sin-datos'" class="tabla-estado">
        <span>No hay registros disponibles.</span>
      </div>

      <!-- Tabla de registros -->
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
                <span
                  class="chip-device"
                  :class="{ 'chip-top': String(getCampo(item, 'DEVICE_ID')) === String(dispositivoAlerta?.id) }"
                >
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

    <!-- ── Footer ─────────────────────────────────────── -->
    <footer class="monitor-footer">
      <span>API Top: <code>{{ CONFIG.URL_API_TOP }}</code></span>
      <span>API Todos: <code>{{ CONFIG.URL_API_TODOS }}</code></span>
      <span>Polling: <code>{{ CONFIG.POLLING_INTERVAL_MS / 1000 }}s</code></span>
    </footer>

  </div>
</template>

<style scoped>
/* ======================================
   Variables de diseño (tema oscuro)
====================================== */
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

/* ======================================
   Header
====================================== */
.monitor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 32px;
  background: var(--clr-surface);
  border-bottom: 1px solid var(--clr-border);
  position: sticky;
  top: 0;
  z-index: 10;
}

.header-left  { display: flex; align-items: center; gap: 12px; }
.header-left h1 {
  font-size: 1.2rem;
  font-weight: 700;
  margin: 0;
  background: linear-gradient(135deg, #fff 0%, var(--clr-accent) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.pulse-dot {
  width: 11px; height: 11px;
  border-radius: 50%;
  background: var(--clr-muted);
  flex-shrink: 0;
  transition: background .3s;
}
.pulse-dot.active {
  background: var(--clr-success);
  animation: pulse-ring 2s infinite;
}
@keyframes pulse-ring {
  0%   { box-shadow: 0 0 0 0   rgba(46,213,115,.4); }
  70%  { box-shadow: 0 0 0 10px rgba(46,213,115,0);  }
  100% { box-shadow: 0 0 0 0   rgba(46,213,115,0);   }
}

.header-right { display: flex; gap: 10px; align-items: center; }

.badge-pill {
  display: flex; align-items: center; gap: 5px;
  font-size: .72rem; color: var(--clr-muted);
  background: var(--clr-surface-2);
  border: 1px solid var(--clr-border);
  padding: 4px 10px; border-radius: 20px;
}

/* ======================================
   Body (tarjetas top + ranking)
====================================== */
.monitor-body {
  padding: 28px 32px 8px;
  display: flex;
  justify-content: center;
}

/* ── Estados (cargando / error / sin datos) ── */
.estado-card {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 48px 40px;
  background: var(--clr-surface);
  border: 1px solid var(--clr-border);
  border-radius: var(--radius);
  max-width: 480px; width: 100%; text-align: center;
}
.estado-icon { font-size: 3rem; }
.estado-card h2 { font-size: 1.2rem; font-weight: 700; margin: 0; }
.estado-card p  { margin: 0; color: var(--clr-muted); font-size: .875rem; }
.estado-card small {
  color: var(--clr-muted); font-size: .72rem;
  font-family: monospace;
  background: var(--clr-surface-2); padding: 3px 8px; border-radius: 6px;
}
.estado-error { border-color: rgba(255,71,87,.3); }
.estado-error h2 { color: var(--clr-critico); }

.spinner {
  width: 38px; height: 38px;
  border: 3px solid var(--clr-border);
  border-top-color: var(--clr-accent);
  border-radius: 50%;
  animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.btn-retry {
  margin-top: 6px; padding: 9px 22px;
  background: transparent;
  border: 1px solid var(--clr-critico);
  color: var(--clr-critico);
  border-radius: var(--radius-sm);
  cursor: pointer; font-size: .85rem; font-weight: 600;
  transition: all .2s;
}
.btn-retry:hover { background: var(--clr-critico); color: #fff; }

/* ── Layout dos tarjetas ── */
.alerta-wrapper {
  display: grid;
  grid-template-columns: 1fr 360px;
  gap: 22px;
  max-width: 1100px;
  width: 100%;
}
@media (max-width: 860px) { .alerta-wrapper { grid-template-columns: 1fr; } }

/* ── Tarjeta de alerta ── */
.alerta-card {
  background: var(--clr-surface);
  border-radius: var(--radius);
  padding: 28px;
  display: flex; flex-direction: column; gap: 22px;
  box-shadow: var(--shadow);
  position: relative; overflow: hidden;
  border: 1px solid var(--clr-border);
  animation: slideUp .4s ease;
}
@keyframes slideUp {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: translateY(0);    }
}

.alerta-card::before {
  content: ''; position: absolute; inset: 0;
  pointer-events: none; border-radius: var(--radius); opacity: .12;
}
.alerta-card.nivel-critico { border-color: rgba(255,71,87,.5); }
.alerta-card.nivel-critico::before { background: radial-gradient(ellipse at top left, var(--clr-critico), transparent 70%); }
.alerta-card.nivel-alto    { border-color: rgba(255,107,53,.4); }
.alerta-card.nivel-alto::before    { background: radial-gradient(ellipse at top left, var(--clr-alto), transparent 70%); opacity: .1; }
.alerta-card.nivel-medio   { border-color: rgba(255,217,61,.25); }

.alerta-badge { font-size: .78rem; font-weight: 700; letter-spacing: .5px; }

.alerta-titulo {
  display: flex; align-items: center; gap: 10px;
  font-size: 1rem; font-weight: 600;
}
.nivel-critico .alerta-titulo svg { stroke: var(--clr-critico); }
.nivel-alto    .alerta-titulo svg { stroke: var(--clr-alto); }
.nivel-medio   .alerta-titulo svg { stroke: var(--clr-medio); }

.alerta-device-id { display: flex; flex-direction: column; gap: 7px; }
.alerta-device-id label {
  font-size: .72rem; text-transform: uppercase; letter-spacing: 1px; color: var(--clr-muted);
}
.device-id-value {
  display: flex; align-items: center; gap: 10px;
  background: var(--clr-surface-2);
  border: 1px solid var(--clr-border);
  border-radius: var(--radius-sm); padding: 12px 16px;
}
.nivel-critico .device-id-value { border-color: rgba(255,71,87,.4); }
.nivel-alto    .device-id-value { border-color: rgba(255,107,53,.4); }
.device-id-value strong {
  font-size: 1.5rem; font-weight: 800;
  font-family: 'Courier New', monospace; letter-spacing: 2px;
}
.nivel-critico .device-id-value strong { color: var(--clr-critico); }
.nivel-alto    .device-id-value strong { color: var(--clr-alto); }
.nivel-medio   .device-id-value strong { color: var(--clr-medio); }
.nivel-critico .device-id-value svg { stroke: var(--clr-critico); }
.nivel-alto    .device-id-value svg { stroke: var(--clr-alto); }
.nivel-medio   .device-id-value svg { stroke: var(--clr-medio); }

.alerta-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.stat-item {
  background: var(--clr-surface-2); border: 1px solid var(--clr-border);
  border-radius: var(--radius-sm); padding: 14px;
  display: flex; flex-direction: column; gap: 5px;
}
.stat-label { font-size: .7rem; text-transform: uppercase; letter-spacing: .8px; color: var(--clr-muted); }
.stat-value { font-size: 1.9rem; font-weight: 800; line-height: 1; }
.nivel-critico .stat-value { color: var(--clr-critico); }
.nivel-alto    .stat-value { color: var(--clr-alto); }
.nivel-medio   .stat-value { color: var(--clr-medio); }

.progress-bar-wrapper { display: flex; flex-direction: column; gap: 5px; font-size: .75rem; color: var(--clr-muted); }
.progress-bar-track { height: 7px; background: var(--clr-surface-2); border-radius: 99px; overflow: hidden; }
.progress-bar-fill  { height: 100%; border-radius: 99px; transition: width .6s ease; }
.nivel-critico .progress-bar-fill { background: linear-gradient(90deg, var(--clr-critico), #ff8c00); }
.nivel-alto    .progress-bar-fill { background: linear-gradient(90deg, var(--clr-alto), var(--clr-critico)); }
.nivel-medio   .progress-bar-fill { background: linear-gradient(90deg, var(--clr-medio), #ff9f43); }

/* ── Etiqueta de estado PASIVO (reemplaza el botón) ── */
.estado-upstream {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px;
  border-radius: var(--radius-sm);
  font-size: .82rem; font-weight: 600;
  border: 1px solid transparent;
}
.tag-critico {
  background: rgba(255,71,87,.1);
  border-color: rgba(255,71,87,.35);
  color: #ff8a94;
}
.tag-critico svg { stroke: var(--clr-critico); }
.tag-alto {
  background: rgba(255,107,53,.1);
  border-color: rgba(255,107,53,.35);
  color: #ffb39a;
}
.tag-alto svg { stroke: var(--clr-alto); }
.tag-medio {
  background: rgba(255,217,61,.08);
  border-color: rgba(255,217,61,.25);
  color: #ffe98a;
}
.tag-medio svg { stroke: var(--clr-medio); }

/* ── Ranking ── */
.ranking-card {
  background: var(--clr-surface);
  border: 1px solid var(--clr-border);
  border-radius: var(--radius); padding: 22px;
  box-shadow: var(--shadow);
  animation: slideUp .4s ease .08s both;
}
.ranking-card h3 {
  display: flex; align-items: center; gap: 7px;
  font-size: .82rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: .8px; color: var(--clr-muted); margin: 0 0 18px;
}
.ranking-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 11px; }
.ranking-list li {
  display: grid;
  grid-template-columns: 24px 1fr auto;
  grid-template-rows: auto 5px;
  gap: 3px 8px; align-items: center;
}
.rank-pos  { font-size: .78rem; font-weight: 700; color: var(--clr-muted); text-align: center; }
.ranking-top .rank-pos { color: var(--clr-critico); }
.rank-id   { font-size: .83rem; font-weight: 600; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rank-count { font-size: .78rem; font-weight: 700; color: var(--clr-muted); }
.ranking-top .rank-count { color: var(--clr-critico); }
.rank-bar { grid-column: 1/-1; height: 4px; background: var(--clr-surface-2); border-radius: 99px; overflow: hidden; }
.rank-bar-fill { height: 100%; background: var(--clr-accent); border-radius: 99px; transition: width .6s ease; }
.ranking-top .rank-bar-fill { background: var(--clr-critico); }

/* ======================================
   Sección: Historial de Registros
====================================== */
.historial-section {
  margin: 20px 32px 0;
  background: var(--clr-surface);
  border: 1px solid var(--clr-border);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow);
}

.historial-header {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;
  padding: 18px 24px;
  border-bottom: 1px solid var(--clr-border);
  background: var(--clr-surface-2);
}
.historial-header h2 {
  display: flex; align-items: center; gap: 9px;
  font-size: .95rem; font-weight: 700; margin: 0;
  color: var(--clr-text);
}
.historial-header h2 svg { stroke: var(--clr-accent); }

.historial-meta { display: flex; align-items: center; gap: 8px; }

.badge-count { background: rgba(108,142,251,.12); border-color: rgba(108,142,251,.3); color: var(--clr-accent); }

.badge-live {
  display: flex; align-items: center; gap: 5px;
  font-size: .65rem; font-weight: 700; letter-spacing: 1px;
  color: var(--clr-success);
  background: rgba(46,213,115,.08);
  border-color: rgba(46,213,115,.3) !important;
}
.live-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--clr-success);
  animation: pulse-ring 2s infinite;
}

/* ── Estado de la tabla ── */
.tabla-estado {
  display: flex; align-items: center; justify-content: center; gap: 12px;
  padding: 40px 24px; color: var(--clr-muted); font-size: .875rem;
}
.spinner-sm {
  width: 22px; height: 22px;
  border: 2px solid var(--clr-border);
  border-top-color: var(--clr-accent);
  border-radius: 50%;
  animation: spin .8s linear infinite;
  flex-shrink: 0;
}
.tabla-error { color: #ff8a94; }
.btn-retry-sm {
  padding: 5px 14px; border: 1px solid var(--clr-critico);
  color: var(--clr-critico); background: transparent;
  border-radius: 6px; cursor: pointer; font-size: .8rem; font-weight: 600;
  transition: all .2s;
}
.btn-retry-sm:hover { background: var(--clr-critico); color: #fff; }

/* ── Tabla scrollable ── */
.tabla-wrapper {
  max-height: v-bind("`${CONFIG.MAX_FILAS_VISIBLES * 44}px`");
  overflow-y: auto;
  /* scrollbar personalizada */
  scrollbar-width: thin;
  scrollbar-color: var(--clr-border) transparent;
}
.tabla-wrapper::-webkit-scrollbar { width: 5px; }
.tabla-wrapper::-webkit-scrollbar-track { background: transparent; }
.tabla-wrapper::-webkit-scrollbar-thumb { background: var(--clr-border); border-radius: 3px; }
.tabla-wrapper::-webkit-scrollbar-thumb:hover { background: var(--clr-accent); }

.registros-tabla {
  width: 100%; border-collapse: collapse;
  font-size: .82rem;
}

.registros-tabla thead {
  position: sticky; top: 0; z-index: 2;
  background: var(--clr-surface-2);
}
.registros-tabla th {
  padding: 10px 16px;
  text-align: left;
  font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .9px;
  color: var(--clr-muted);
  border-bottom: 1px solid var(--clr-border);
  white-space: nowrap;
}

.registros-tabla td {
  padding: 10px 16px;
  border-bottom: 1px solid rgba(37,42,56,.6);
  color: var(--clr-text);
  vertical-align: middle;
}

.registros-tabla tbody tr { transition: background .15s; }
.registros-tabla tbody tr:hover { background: var(--clr-surface-2); }

/* Fila del dispositivo infractor resaltada */
.row-highlight td { background: rgba(255,71,87,.05); }
.row-highlight:hover td { background: rgba(255,71,87,.1) !important; }

.col-id     { font-family: monospace; color: var(--clr-muted); width: 60px; }
.col-device { width: 120px; }
.col-valor  { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-fecha  { color: var(--clr-muted); font-size: .75rem; white-space: nowrap; }

/* Chip de dispositivo */
.chip-device {
  display: inline-block;
  padding: 2px 9px;
  border-radius: 20px;
  font-family: monospace; font-size: .78rem; font-weight: 600;
  background: var(--clr-surface-2);
  border: 1px solid var(--clr-border);
  color: var(--clr-muted);
}
.chip-top {
  background: rgba(255,71,87,.12);
  border-color: rgba(255,71,87,.35);
  color: #ff8a94;
}

/* ======================================
   Footer
====================================== */
.monitor-footer {
  display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
  margin-top: 20px;
  padding: 13px 32px;
  border-top: 1px solid var(--clr-border);
  font-size: .7rem; color: var(--clr-muted);
  background: var(--clr-surface);
}
.monitor-footer code {
  background: var(--clr-surface-2); padding: 2px 7px;
  border-radius: 4px; font-size: .68rem; color: var(--clr-accent);
}
</style>
