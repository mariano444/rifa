const SUPABASE_URL = 'https://asokopamdmuvuupywjzt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_zBhxdMJHw_uy_m3uRDj-ng_0yXz42EN';
const CAMPAIGN_SLUG = 'sorteo-volkswagen-gol-trend';
// Este es el slug que ya usaba el RPC. Si el campaign_id 04aa8b72-c031-4f60-b827-a5a9380b6f7e
// corresponde a esta misma campaña, no hace falta tocar nada más. Si es una campaña
// distinta, reemplazá el valor de arriba por SU slug (lo buscás en la tabla
// "campaigns" en Supabase Studio, columna "slug" — es una simple lectura, no
// requiere configurar RLS).
const CAMPAIGN_ID_REFERENCE = '00d5419e-6f9c-494a-856c-ec01688d41b4'; // id de la campaña que queremos usar
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ⚠️ SOLO PARA PRUEBAS: fuerza que la demostración termine deteniéndose en este
// participante en lugar de uno al azar. Para volver al comportamiento real
// (aleatorio), poner ambas constantes en null.
// El RPC no expone el UUID crudo, así que el match final se hace por nombre;
// dejamos el id igual como referencia/documentación.
const FORCED_WINNER_PARTICIPANT_ID = '195627ae-3c64-4366-ae5b-7af3c04314ed'; // solo referencia
const FORCED_WINNER_NAME = 'Soledad Mesa';

// La demo debe recorrer a todos los participantes de la campaña rápido.
const DEMO_TOTAL_DURATION_MS = 20000; // ~20 segundos, recorrido veloz
const DEMO_FINAL_PAUSE_MS = 1600;

let participants = [];
let currentParticipants = [];
let demoResults = [];
let drawAnimationTimeout = null;
let mediaRecorder = null;
let recordedChunks = [];
let screenStream = null;
let isRecording = false;

const drawShowcaseState = {
  basePool: [],
  cycle: [],
  cyclePosition: 0,
  spotlightPosition: -1,
  stepDelayMs: 60,
  round: 0,
  activeParticipantIndex: -1,
  activeEntryNumber: 0,
  activeEntryPosition: 0,
  activeSpotlight: false,
  paused: false,
  historyOpen: false,
  hasStarted: false
};

const COLORS = ['#F5C842','#3B8BFF','#00D46A','#FF6B3B','#BF5FFF','#FF3B7A'];
function colorFor(i){ return COLORS[i % COLORS.length]; }
function initials(name){ return String(name || '??').trim().split(/\s+/).map(w => w[0]).join('').substring(0,2).toUpperCase(); }

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function participantLocation(participant) {
  const province = participant.province || '';
  const city = participant.city || '';
  return province || city || 'Argentina';
}

function normalizeParticipantLocation(row) {
  const rawProvince = (row.province || '').trim();
  const rawCity = (row.city || '').trim();
  const normalizedCity = rawCity.toLowerCase();
  const hasLegacyLocation = !rawProvince && rawCity && normalizedCity !== 'argentina';
  return {
    province: hasLegacyLocation ? rawCity : rawProvince,
    city: hasLegacyLocation || normalizedCity === 'argentina' ? '' : rawCity
  };
}

function shuffleList(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 4500);
}

async function startScreenRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    showToast('Este navegador no permite grabar la pantalla. La demo se ejecuta sin video.');
    return false;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false
    });
  } catch (error) {
    showToast('No se otorgó permiso para grabar la pantalla. La demo se ejecuta sin video.');
    return false;
  }

  recordedChunks = [];
  const mimeType = (window.MediaRecorder && MediaRecorder.isTypeSupported('video/webm;codecs=vp9'))
    ? 'video/webm;codecs=vp9'
    : 'video/webm';

  try {
    mediaRecorder = new MediaRecorder(screenStream, { mimeType });
  } catch (error) {
    mediaRecorder = new MediaRecorder(screenStream);
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `demo-sorteo-${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast('Video de la demostración descargado.');
    if (screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      screenStream = null;
    }
    isRecording = false;
    const startBtn = document.getElementById('drawStartBtn');
    if (startBtn) startBtn.textContent = '▶ Iniciar prueba';
    updateDrawControls();
  };

  // Si el usuario detiene el compartir pantalla desde el navegador
  screenStream.getVideoTracks()[0].addEventListener('ended', () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  });

  mediaRecorder.start();
  isRecording = true;
  return true;
}

function stopScreenRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function getParticipantChances(participant) {
  return Math.max(1, Number(participant.currentChances || participant.purchasedChances || participant.chances || 0));
}

function hasProfilePhoto(participant) {
  return Boolean(participant && participant.photoUrl && String(participant.photoUrl).trim());
}

// Pinta la foto de perfil real dentro de un contenedor de avatar (con fallback
// a las iniciales si no hay foto o si la imagen no carga).
function renderParticipantAvatar(container, participant, colorIndex) {
  if (!container) return;
  const color = colorFor(colorIndex);
  container.style.background = `${color}22`;
  container.style.color = color;
  container.innerHTML = '';
  if (hasProfilePhoto(participant)) {
    const img = document.createElement('img');
    img.src = participant.photoUrl;
    img.alt = participant.displayName || participant.name || '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      container.innerHTML = '';
      container.textContent = initials(participant.displayName || participant.name);
    }, { once: true });
    container.appendChild(img);
  } else {
    container.textContent = initials(participant.displayName || participant.name);
  }
}

function makeDrawEntry(participant, participantIndex) {
  return {
    participantIndex,
    chanceNumber: 1,
    chanceLabel: `${participant.displayName || participant.name} · demo`
  };
}

// Arma el recorrido con una sola entrada por participante (no por chance),
// para que el paso sea mas agil, cubriendo casi todos los participantes
// (se descarta una pequeña porcion al azar para variar cada ronda) y
// alternando la aparicion dandole prioridad a quienes tienen foto de perfil.
function buildDrawEntryPoolBase() {
  const withPhoto = shuffleList(
    currentParticipants
      .map((participant, participantIndex) => ({ participant, participantIndex }))
      .filter((item) => hasProfilePhoto(item.participant))
  );
  const withoutPhoto = shuffleList(
    currentParticipants
      .map((participant, participantIndex) => ({ participant, participantIndex }))
      .filter((item) => !hasProfilePhoto(item.participant))
  );

  const KEEP_RATIO = 1; // recorrer a TODOS los participantes de la campaña
  const trimmedWithoutPhoto = withoutPhoto.slice(0, Math.max(0, Math.round(withoutPhoto.length * KEEP_RATIO)));
  const trimmedWithPhoto = withPhoto.slice(0, Math.max(0, Math.round(withPhoto.length * KEEP_RATIO)));

  const PHOTO_PRIORITY = 2; // por cada 1 sin foto, aparecen hasta 2 con foto
  const pool = [];
  let pIndex = 0;
  let oIndex = 0;
  while (pIndex < trimmedWithPhoto.length || oIndex < trimmedWithoutPhoto.length) {
    for (let k = 0; k < PHOTO_PRIORITY && pIndex < trimmedWithPhoto.length; k += 1) {
      const item = trimmedWithPhoto[pIndex];
      pool.push(makeDrawEntry(item.participant, item.participantIndex));
      pIndex += 1;
    }
    if (oIndex < trimmedWithoutPhoto.length) {
      const item = trimmedWithoutPhoto[oIndex];
      pool.push(makeDrawEntry(item.participant, item.participantIndex));
      oIndex += 1;
    }
  }
  return pool;
}

function refreshDrawEntryPool() {
  drawShowcaseState.basePool = buildDrawEntryPoolBase();
}

function getDrawNarrative(participant, isSpotlight, cycleProgress) {
  if (isSpotlight) {
    return 'La demostracion alcanzo el punto final de la prueba y deja visible la chance exacta seleccionada dentro de la urna.';
  }
  if (cycleProgress < 0.2) return 'El sistema oficial comenzo a recorrer la urna completa, incluyendo cada chance activa de cada participante.';
  if (cycleProgress > 0.72) return ' ';
  return 'El sistema sigue recorriendo chances individuales en tiempo real para mostrar el ganador/ganadora.';
}

function getActiveDemoParticipant() {
  if (drawShowcaseState.activeParticipantIndex < 0 || !currentParticipants[drawShowcaseState.activeParticipantIndex]) {
    return null;
  }
  return currentParticipants[drawShowcaseState.activeParticipantIndex];
}

function renderDemoHistory() {
  const grid = document.getElementById('demoHistoryGrid');
  if (!grid) return;
  if (!demoResults.length) {
    grid.innerHTML = '<div class="demo-history-empty-gp">Todavia no hay resultados de demostracion guardados.</div>';
    return;
  }
  grid.innerHTML = demoResults.map((item) => `
    <div class="demo-history-card">
      <strong>${escapeHtml(item.display_name || item.full_name || 'Participante')}</strong>
      <div class="demo-history-meta">
        <span>${escapeHtml([item.city || '', item.province || ''].filter(Boolean).join(', ') || 'Argentina')}</span>
        <span>${escapeHtml(item.recorded_at_label || '')}</span>
      </div>
      <div class="demo-history-meta">
        <span>${escapeHtml(item.public_code || 'Registro demo')}</span>
        <span>x${Number(item.chances || 0).toLocaleString('es-AR')}</span>
      </div>
    </div>
  `).join('');
}

function toggleDemoHistory() {
  drawShowcaseState.historyOpen = !drawShowcaseState.historyOpen;
  const panel = document.getElementById('demoHistoryPanel');
  const button = document.getElementById('toggleDemoHistoryBtn');
  panel?.classList.toggle('open', drawShowcaseState.historyOpen);
  if (button) {
    button.textContent = drawShowcaseState.historyOpen ? 'Ocultar participantes demo' : 'Participantes demostracion';
  }
}

function toggleDemoShowcase() {
  const showcase = document.getElementById('drawShowcase');
  const button = document.getElementById('toggleDemoBtn');
  if (!showcase || !button) return;
  showcase.classList.remove('hidden');
  const willOpen = showcase.classList.contains('collapsed');
  showcase.classList.toggle('collapsed', !willOpen);
  button.textContent = willOpen ? 'Ocultar demostración' : 'Mostrar demostración';
}

function updateDrawControls() {
  const showcase = document.getElementById('drawShowcase');
  const startBtn = document.getElementById('drawStartBtn');
  const saveBtn = document.getElementById('saveDemoResultBtn');
  if (!showcase || !startBtn || !saveBtn) return;
  showcase.classList.toggle('paused', drawShowcaseState.paused);
  startBtn.disabled = !participants.length || drawShowcaseState.hasStarted;
  startBtn.style.opacity = startBtn.disabled ? '0.5' : '1';
  saveBtn.disabled = !getActiveDemoParticipant() || !drawShowcaseState.paused || !drawShowcaseState.hasStarted;
  saveBtn.style.opacity = saveBtn.disabled ? '0.5' : '1';
}

function pauseDrawShowcase() {
  drawShowcaseState.paused = true;
  stopDrawShowcase();
  updateDrawControls();
  const el1 = document.getElementById('drawPhaseLabel');
  const el2 = document.getElementById('drawPhaseName');
  const el3 = document.getElementById('drawPhaseHint');
  if (el1) el1.textContent = 'Prueba detenida';
  if (el2) el2.textContent = 'El software freno en el foco actual';
  if (el3) el3.textContent = 'Ahora puedes registrar este resultado de demostracion. Este dato sirve solo como evidencia visual del funcionamiento y no como resultado oficial.';

  // Dejamos un instante para que el frame final quede en el video antes de cortar la grabacion.
  if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') {
    setTimeout(() => stopScreenRecording(), 1400);
  }
}

function startDemoTrial() {
  if (!participants.length) {
    renderDrawShowcaseEmpty();
    return;
  }
  drawShowcaseState.hasStarted = true;
  drawShowcaseState.paused = false;
  updateDrawControls();
  if (!drawShowcaseState.cycle.length || drawShowcaseState.cyclePosition >= drawShowcaseState.cycle.length) {
    prepareDrawShowcaseRound();
  }
  tickDrawShowcase();
  const pl = document.getElementById('drawPhaseLabel');
  const pn = document.getElementById('drawPhaseName');
  const ph = document.getElementById('drawPhaseHint');
  if (pl) pl.textContent = 'Prueba en curso';
  if (pn) pn.textContent = 'El software esta recorriendo participantes en vivo';
  if (ph) ph.textContent = 'La prueba se detendra sola en el elegido y luego podras registrar ese resultado.';
}

function getDrawDelay(participant, isSpotlight) {
  if (isSpotlight) return DEMO_FINAL_PAUSE_MS;
  return drawShowcaseState.stepDelayMs || 60;
}

function renderDrawShowcaseEmpty() {
  const rail = document.getElementById('drawRail');
  const card = document.getElementById('drawFeaturedCard');
  document.getElementById('drawShowcase')?.classList.remove('is-focus-locked');
  drawShowcaseState.activeParticipantIndex = -1;
  drawShowcaseState.activeEntryNumber = 0;
  drawShowcaseState.activeEntryPosition = 0;
  drawShowcaseState.activeSpotlight = false;
  drawShowcaseState.hasStarted = false;
  if (card) card.classList.remove('spotlight');
  const elRoundCounter = document.getElementById('drawRoundCounter');
  const elAvatar = document.getElementById('drawFeaturedAvatar');
  const elName = document.getElementById('drawFeaturedName');
  const elMeta = document.getElementById('drawFeaturedMeta');
  const elScore = document.getElementById('drawFeaturedScore');
  const elPhaseLabel = document.getElementById('drawPhaseLabel');
  const elPhaseName = document.getElementById('drawPhaseName');
  const elPhaseHint = document.getElementById('drawPhaseHint');
  const elIntelFill = document.getElementById('drawIntelFill');
  if (elRoundCounter) elRoundCounter.textContent = '0';
  if (elAvatar) { elAvatar.textContent = '--'; elAvatar.style.background = 'rgba(255,255,255,0.06)'; elAvatar.style.color = 'var(--silver)'; }
  if (elName) elName.textContent = 'La animacion se activara sola';
  if (elMeta) elMeta.innerHTML = '<span class="draw-featured-pill">Sin datos todavia</span>';
  if (elScore) elScore.textContent = '0';
  if (elPhaseLabel) elPhaseLabel.textContent = 'Prueba disponible';
  if (elPhaseName) elPhaseName.textContent = 'Lista para iniciar la demostracion del funcionamiento';
  if (elPhaseHint) elPhaseHint.textContent = 'Pulsa iniciar prueba, deja que el sistema recorra la lista y luego registra el punto exacto donde freno.';
  if (elIntelFill) elIntelFill.style.width = '18%';
  updateDrawControls();
  if (rail) {
    rail.innerHTML = '<div class="draw-rail-empty-gp">Todavia no hay participantes visibles para iniciar el recorrido animado.</div>';
  }
}

async function loadDemoResults() {
  try {
    const { data, error } = await supabaseClient.rpc('list_demo_draw_results', {
      p_campaign_slug: CAMPAIGN_SLUG
    });
    if (error) throw error;
    demoResults = (data || []).map((row) => ({
      ...row,
      recorded_at_label: row.recorded_at
        ? new Date(row.recorded_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : ''
    }));
  } catch (error) {
    console.warn('No se pudo cargar el historial demo.', error);
    demoResults = [];
  }
  renderDemoHistory();
}

async function saveCurrentDemoResult() {
  const participant = getActiveDemoParticipant();
  if (!participant) {
    showToast('Todavia no hay un participante seleccionado donde freno la prueba.');
    return;
  }
  try {
    const { error } = await supabaseClient.rpc('record_demo_draw_result', {
      p_campaign_slug: CAMPAIGN_SLUG,
      p_participant_public_code: participant.publicCode || '',
      p_display_name: participant.displayName || participant.name,
      p_full_name: participant.name || participant.displayName || ''
    });
    if (error) throw error;
    const now = new Date();
    demoResults = [
      {
        display_name: participant.displayName || participant.name,
        full_name: participant.name || participant.displayName || '',
        city: participant.city || '',
        province: participant.province || '',
        public_code: participant.publicCode || '',
        chances: Number(participant.currentChances || participant.chances || 0),
        recorded_at: now.toISOString(),
        recorded_at_label: now.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      },
      ...demoResults
    ];
    renderDemoHistory();
    if (!drawShowcaseState.historyOpen) {
      toggleDemoHistory();
    }
    showToast(`Resultado registrado donde freno: ${participant.displayName || participant.name}.`);
  } catch (error) {
    console.error(error);
    showToast('No se pudo registrar donde freno la prueba. Revisa la migracion SQL.');
  }
}

function renderDrawShowcase(entry, isSpotlight, delay) {
  if (!currentParticipants.length || !entry || typeof entry.participantIndex !== 'number') {
    renderDrawShowcaseEmpty();
    return;
  }

  const activeIndex = entry.participantIndex;
  const participant = currentParticipants[activeIndex];
  if (!participant) {
    renderDrawShowcaseEmpty();
    return;
  }
  const activeColor = colorFor(activeIndex);
  drawShowcaseState.activeParticipantIndex = activeIndex;
  drawShowcaseState.activeEntryNumber = entry.chanceNumber;
  drawShowcaseState.activeEntryPosition = drawShowcaseState.cyclePosition + 1;
  drawShowcaseState.activeSpotlight = Boolean(isSpotlight);
  const rail = document.getElementById('drawRail');
  const featuredCard = document.getElementById('drawFeaturedCard');
  const featuredAvatar = document.getElementById('drawFeaturedAvatar');
  const featuredName = document.getElementById('drawFeaturedName');
  const featuredMeta = document.getElementById('drawFeaturedMeta');
  const featuredScore = document.getElementById('drawFeaturedScore');
  const phaseLabel = document.getElementById('drawPhaseLabel');
  const phaseName = document.getElementById('drawPhaseName');
  const phaseHint = document.getElementById('drawPhaseHint');
  const intelFill = document.getElementById('drawIntelFill');

  if (!featuredCard || !featuredAvatar || !featuredName || !featuredMeta || !featuredScore) {
    if (delay && delay > 0) {
      drawAnimationTimeout = setTimeout(tickDrawShowcase, delay);
    }
    return;
  }

  const cycleProgress = drawShowcaseState.cycle.length
    ? (drawShowcaseState.cyclePosition + 1) / drawShowcaseState.cycle.length
    : 0;
  document.getElementById('drawShowcase')?.classList.toggle('is-focus-locked', Boolean(isSpotlight));

  featuredCard.classList.toggle('spotlight', Boolean(isSpotlight));
  renderParticipantAvatar(featuredAvatar, participant, activeIndex);
  featuredName.textContent = participant.displayName || participant.name;
  featuredMeta.innerHTML = `
    <span class="draw-featured-pill">${escapeHtml(participant.province || 'Argentina')}</span>
    <span class="draw-featured-pill">${escapeHtml(participant.city || 'Sin ciudad')}</span>
    <span class="draw-featured-pill">${escapeHtml(participant.date || 'Hoy')}</span>
    <span class="draw-featured-pill">${participant.publicCode ? escapeHtml(participant.publicCode) : 'Registro visible'}</span>
  `;
  featuredScore.textContent = getParticipantChances(participant).toLocaleString('es-AR');
  const elRC = document.getElementById('drawRoundCounter');
  if (elRC) elRC.textContent = String(drawShowcaseState.round);

  if (phaseLabel) phaseLabel.textContent = isSpotlight ? 'Pausa aleatoria' : 'Recorrido dinamico';
  if (phaseName) phaseName.textContent = isSpotlight
    ? `${participant.displayName || participant.name} quedo seleccionado en la demostracion`
    : 'La lista esta recorriendo participantes en tiempo real';
  if (phaseHint) phaseHint.textContent = getDrawNarrative(participant, isSpotlight, cycleProgress);
  if (intelFill) intelFill.style.width = `${Math.max(16, Math.min(100, cycleProgress * 100))}%`;

  const cardCount = Math.min(Math.max(drawShowcaseState.cycle.length, 1), 5);
  const fragment = document.createDocumentFragment();
  for (let offset = 0; offset < cardCount; offset += 1) {
    const cyclePosition = (drawShowcaseState.cyclePosition + offset) % drawShowcaseState.cycle.length;
    const cycleEntry = drawShowcaseState.cycle[cyclePosition];
    if (!cycleEntry || typeof cycleEntry.participantIndex !== 'number') {
      continue;
    }
    const item = currentParticipants[cycleEntry.participantIndex];
    if (!item) {
      continue;
    }
    const card = document.createElement('div');
    card.className = 'draw-rail-card'
      + (offset === 0 ? ' active' : '')
      + (cyclePosition === drawShowcaseState.spotlightPosition ? ' spotlight' : '');

    const avatar = document.createElement('div');
    avatar.className = 'draw-rail-avatar-sm';
    renderParticipantAvatar(avatar, item, cycleEntry.participantIndex);
    card.appendChild(avatar);

    const info = document.createElement('div');
    info.className = 'draw-rail-info';
    info.innerHTML = `
      <span class="draw-rail-name">${escapeHtml(item.displayName || item.name)}</span>
      <div class="draw-rail-meta">
        <span>${escapeHtml(participantLocation(item))}</span>
        <span>${item.publicCode ? escapeHtml(item.publicCode) : `Chance ${cycleEntry.chanceNumber}`}</span>
      </div>
    `;
    card.appendChild(info);
    fragment.appendChild(card);
  }
  rail.innerHTML = '';
  rail.appendChild(fragment);
}

function stopDrawShowcase() {
  if (drawAnimationTimeout) {
    clearTimeout(drawAnimationTimeout);
    drawAnimationTimeout = null;
  }
}

function normalizeMatchText(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

function findForcedWinnerIndex() {
  const targets = [FORCED_WINNER_PARTICIPANT_ID, FORCED_WINNER_NAME]
    .filter(Boolean)
    .map(normalizeMatchText);
  if (!targets.length) return -1;
  return currentParticipants.findIndex((p) => {
    const raw = p._raw || {};
    const fieldValues = Object.values(raw)
      .concat([p.id, p.publicCode, p.name, p.displayName])
      .map(normalizeMatchText)
      .filter(Boolean);
    return fieldValues.some((v) => targets.includes(v));
  });
}

function prepareDrawShowcaseRound() {
  // Si hay un participante forzado para pruebas, lo sacamos del pool base,
  // barajamos el resto y lo agregamos al final: así la demo recorre a TODOS
  // los demás participantes antes de detenerse justo en él.
  let pool = drawShowcaseState.basePool.slice();
  let winnerEntry = null;
  if (FORCED_WINNER_PARTICIPANT_ID || FORCED_WINNER_NAME) {
    const winnerParticipantIndex = findForcedWinnerIndex();
    if (winnerParticipantIndex !== -1) {
      const winnerEntryIndex = pool.findIndex(e => e.participantIndex === winnerParticipantIndex);
      if (winnerEntryIndex !== -1) {
        winnerEntry = pool.splice(winnerEntryIndex, 1)[0];
        console.log('[demo] Ganador forzado encontrado:', currentParticipants[winnerParticipantIndex]);
      }
    } else if (currentParticipants.length) {
      console.warn('No se encontró al participante forzado (ni por id ni por nombre) entre los campos devueltos por el RPC.', {
        buscadoId: FORCED_WINNER_PARTICIPANT_ID,
        buscadoNombre: FORCED_WINNER_NAME,
        primerParticipante: currentParticipants[0] && currentParticipants[0]._raw
      });
      showToast('No se encontró a ese participante (ni por id ni por nombre). Se eligió uno al azar.');
    }
  }

  const shuffled = shuffleList(pool);
  drawShowcaseState.cycle = winnerEntry ? [...shuffled, winnerEntry] : shuffled;
  drawShowcaseState.cyclePosition = 0;
  drawShowcaseState.spotlightPosition = winnerEntry
    ? drawShowcaseState.cycle.length - 1
    : (drawShowcaseState.cycle.length ? Math.floor(Math.random() * drawShowcaseState.cycle.length) : -1);
  drawShowcaseState.round += 1;

  // Repartimos el tiempo total (2 minutos) entre todos los pasos del recorrido,
  // dejando aparte la pausa final donde se muestra el resultado.
  const stepCount = Math.max(1, drawShowcaseState.cycle.length - 1);
  drawShowcaseState.stepDelayMs = Math.max(15, Math.floor((DEMO_TOTAL_DURATION_MS - DEMO_FINAL_PAUSE_MS) / stepCount));
}

function tickDrawShowcase() {
  if (!currentParticipants.length) {
    stopDrawShowcase();
    renderDrawShowcaseEmpty();
    return;
  }
  if (drawShowcaseState.paused) {
    updateDrawControls();
    return;
  }

  if (!drawShowcaseState.cycle.length || drawShowcaseState.cyclePosition >= drawShowcaseState.cycle.length) {
    prepareDrawShowcaseRound();
  }
  if (!drawShowcaseState.cycle.length) {
    renderDrawShowcaseEmpty();
    return;
  }

  const cyclePosition = drawShowcaseState.cyclePosition;
  const entry = drawShowcaseState.cycle[cyclePosition];
  if (!entry || typeof entry.participantIndex !== 'number' || !currentParticipants[entry.participantIndex]) {
    drawShowcaseState.cyclePosition += 1;
    if (drawShowcaseState.cyclePosition >= drawShowcaseState.cycle.length) {
      prepareDrawShowcaseRound();
    }
    tickDrawShowcase();
    return;
  }
  const isSpotlight = cyclePosition === drawShowcaseState.spotlightPosition;
  const participant = currentParticipants[entry.participantIndex];
  const delay = getDrawDelay(participant, isSpotlight);
  renderDrawShowcase(entry, isSpotlight, delay);
  drawShowcaseState.cyclePosition += 1;
  if (isSpotlight) {
    drawAnimationTimeout = setTimeout(() => {
      pauseDrawShowcase();
    }, delay);
    return;
  }
  drawAnimationTimeout = setTimeout(() => {
    if (drawShowcaseState.cyclePosition >= drawShowcaseState.cycle.length) {
      prepareDrawShowcaseRound();
    }
    tickDrawShowcase();
  }, delay);
}

function startDrawShowcase() {
  stopDrawShowcase();
  const showcase = document.getElementById('drawShowcase');
  if (!currentParticipants.length) {
    renderDrawShowcaseEmpty();
    return;
  }
  if (showcase) {
    showcase.classList.remove('hidden');
    showcase.classList.remove('collapsed');
  }
  drawShowcaseState.paused = true;
  drawShowcaseState.hasStarted = false;
  updateDrawControls();
  prepareDrawShowcaseRound();
  if (!drawShowcaseState.cycle.length) {
    renderDrawShowcaseEmpty();
    return;
  }
  const entry = drawShowcaseState.cycle[drawShowcaseState.cyclePosition];
  if (!entry || typeof entry.participantIndex !== 'number' || !currentParticipants[entry.participantIndex]) {
    renderDrawShowcaseEmpty();
    return;
  }
  const participant = currentParticipants[entry.participantIndex];
  const delay = getDrawDelay(participant, false);
  renderDrawShowcase(entry, false, delay);
}

async function loadParticipants(){
  // Usamos el RPC ya existente (SECURITY DEFINER): no depende de policies de
  // RLS para el anon key. Probamos primero pasando el campaign_id (por si el
  // RPC lo soporta como parámetro alternativo); si falla o no trae datos,
  // caemos al slug configurado como antes.
  let data = null;
  let usedMethod = 'slug';

  try {
    const byId = await supabaseClient.rpc('list_public_participants', {
      p_campaign_id: CAMPAIGN_ID_REFERENCE
    });
    if (!byId.error && byId.data && byId.data.length) {
      data = byId.data;
      usedMethod = 'campaign_id';
    } else if (byId.error) {
      console.warn('[demo] El RPC no acepta p_campaign_id, se usa el slug configurado.', byId.error.message);
    }
  } catch (e) {
    console.warn('[demo] Falló el intento por campaign_id, se usa el slug configurado.', e);
  }

  if (!data) {
    const bySlug = await supabaseClient.rpc('list_public_participants', {
      p_campaign_slug: CAMPAIGN_SLUG
    });
    if (bySlug.error) throw bySlug.error;
    data = bySlug.data;
    usedMethod = 'slug';
  }

  console.log(`[demo] Participantes cargados vía "${usedMethod}". Total: ${(data || []).length}`);

  // Debug: mostramos en consola la primera fila cruda del RPC para poder
  // confirmar qué campos trae realmente (por si el nombre del id difiere).
  if (data && data.length) {
    console.log('[demo] Ejemplo de fila devuelta por list_public_participants:', data[0]);
    console.log('[demo] Campos disponibles:', Object.keys(data[0]));
  }

  participants = (data || []).map((row, index) => {
    const location = normalizeParticipantLocation(row);
    const isAnonymous = Boolean(row.is_anonymous);
    const displayName = row.display_name || row.full_name || 'Participante';
    const fullName = row.full_name || displayName;
    const joinedAt = row.joined_at ? new Date(row.joined_at) : new Date();
    return {
      id: row.id || row.participant_id || row.uuid || String(index),
      sourceIndex: index,
      name: fullName,
      displayName,
      isAnonymous,
      publicCode: row.public_code || '',
      photoUrl: row.photo_url || '',
      province: location.province,
      city: location.city,
      chances: Number(row.total_entries || 0),
      currentChances: Math.max(Number(row.purchased_entries || 0), Number(row.total_entries || 0)),
      date: joinedAt.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      joinedAt,
      _raw: row // guardamos la fila cruda para poder buscar el id forzado en cualquier campo
    };
  });

  // Se recorren todos los participantes que devuelve el RPC para esta campaña.
  currentParticipants = participants;

  refreshDrawEntryPool();
}

document.getElementById('toggleDemoBtn').addEventListener('click', toggleDemoShowcase);
document.getElementById('saveDemoResultBtn').addEventListener('click', saveCurrentDemoResult);
document.getElementById('toggleDemoHistoryBtn').addEventListener('click', toggleDemoHistory);

document.getElementById('drawStartBtn').addEventListener('click', async () => {
  const startBtn = document.getElementById('drawStartBtn');
  const originalLabel = startBtn.textContent;
  startBtn.disabled = true;
  startBtn.textContent = 'Solicitando permiso...';
  const recorded = await startScreenRecording();
  startBtn.textContent = recorded ? '● Grabando · en curso' : originalLabel;
  startDemoTrial();
});

function renderParticipantsMarquee() {
  const viewport = document.getElementById('marqueeViewport');
  const track = document.getElementById('marqueeTrack');
  const countEl = document.getElementById('marqueeCount');
  if (!track || !viewport) return;

  if (countEl) countEl.textContent = String(currentParticipants.length);

  if (!currentParticipants.length) {
    track.innerHTML = '<div class="marquee-empty">Todavía no hay participantes para mostrar.</div>';
    track.style.animation = 'none';
    return;
  }

  const buildCard = (participant, participantIndex) => {
    const card = document.createElement('div');
    card.className = 'marquee-card';

    const avatar = document.createElement('div');
    avatar.className = 'marquee-avatar';
    renderParticipantAvatar(avatar, participant, participantIndex);
    card.appendChild(avatar);

    const info = document.createElement('div');
    info.className = 'marquee-info';
    info.innerHTML = `
      <span class="marquee-name">${escapeHtml(participant.displayName || participant.name)}</span>
      <div class="marquee-meta">
        <span>${escapeHtml(participantLocation(participant))}</span>
        <span class="marquee-chances">x${getParticipantChances(participant).toLocaleString('es-AR')}</span>
      </div>
    `;
    card.appendChild(info);
    return card;
  };

  // Se arma la lista completa duplicada (dos veces seguidas) para que el
  // loop de la animación sea continuo y sin cortes visuales.
  const fragment = document.createDocumentFragment();
  for (let pass = 0; pass < 2; pass += 1) {
    currentParticipants.forEach((participant, participantIndex) => {
      fragment.appendChild(buildCard(participant, participantIndex));
    });
  }
  track.innerHTML = '';
  track.appendChild(fragment);

  // La velocidad se adapta a la cantidad de participantes para que el
  // desplazamiento se sienta parejo sin importar si son 20 o 2000.
  const durationSeconds = Math.min(180, Math.max(18, currentParticipants.length * 0.9));
  track.style.animation = 'none';
  // Forzamos reflow para reiniciar la animación con la nueva duración.
  void track.offsetWidth;
  track.style.animation = `marquee-scroll ${durationSeconds}s linear infinite`;

  viewport.addEventListener('click', () => {
    viewport.classList.toggle('paused');
  });
}

async function bootDemo(){
  try {
    await loadParticipants();
    await loadDemoResults();
    renderParticipantsMarquee();
    startDrawShowcase();
  } catch (error) {
    console.error(error);
    showToast('No se pudo cargar la demostración conectada a Supabase.');
  }
}

bootDemo();
