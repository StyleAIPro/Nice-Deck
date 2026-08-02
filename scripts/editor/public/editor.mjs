import { connectEvents } from './ws-client.mjs';

const params = new URLSearchParams(location.search);
const token = params.get('token') ?? '';
const editorToken = params.get('editorToken') ?? '';
const deckFrame = document.querySelector('#deck-frame');
const pageList = document.querySelector('[data-page-list]');
const pageCount = document.querySelector('[data-page-count]');
const currentPage = document.querySelector('[data-current-page]');
const currentKey = document.querySelector('[data-current-key]');
const wsState = document.querySelector('[data-ws-state]');
const wsLabel = document.querySelector('[data-ws-label]');
const frameViewport = document.querySelector('[data-frame-viewport]');
const frameScene = document.querySelector('[data-frame-scene]');
const zoomValue = document.querySelector('[data-zoom]');

deckFrame.src = `/preview?token=${encodeURIComponent(token)}`;

function selectPage(button) {
  for (const item of pageList.querySelectorAll('[data-page-key]')) {
    item.setAttribute('aria-current', item === button ? 'page' : 'false');
  }
  currentPage.textContent = button.textContent;
  currentKey.textContent = button.dataset.pageKey;
}

function renderPages(pages) {
  pageList.replaceChildren();
  for (const page of pages) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'page-item';
    button.dataset.pageKey = page.pageKey;
    button.textContent = `${String(page.index).padStart(2, '0')} ${page.label}`;
    button.setAttribute('aria-current', 'false');
    button.addEventListener('click', () => selectPage(button));
    pageList.append(button);
  }
  pageCount.textContent = `${pages.length} 页`;
  const firstPage = pageList.querySelector('[data-page-key]');
  if (firstPage) selectPage(firstPage);
}

window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== deckFrame.contentWindow) return;
  if (event.data?.type !== 'deck-ready' || !Array.isArray(event.data.pages)) return;
  renderPages(event.data.pages);
});

function fitFrame() {
  const availableWidth = Math.max(frameViewport.clientWidth - 56, 1);
  const availableHeight = Math.max(frameViewport.clientHeight - 56, 1);
  const scale = Math.min(availableWidth / 1920, availableHeight / 1080, 1);
  frameScene.style.width = `${Math.round(1920 * scale)}px`;
  frameScene.style.height = `${Math.round(1080 * scale)}px`;
  deckFrame.style.transform = `scale(${scale})`;
  zoomValue.textContent = `${Math.round(scale * 100)}%`;
}

const resizeObserver = new ResizeObserver(() => requestAnimationFrame(fitFrame));
resizeObserver.observe(frameViewport);
fitFrame();

const eventsUrl = new URL('/events', location.href);
eventsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
eventsUrl.searchParams.set('editorToken', editorToken);
connectEvents({
  url: eventsUrl,
  token,
  onEvent: () => {},
  onState: state => {
    wsState.dataset.wsState = state;
    wsLabel.textContent = state === 'online' ? '在线' : '离线';
  },
});
