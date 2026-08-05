const button = document.querySelector('[data-add-deck]');
const buttonLabel = document.querySelector('[data-button-label]');
const status = document.querySelector('[data-status]');
const token = new URLSearchParams(window.location.search).get('token');
let state = 'idle';

function setState(nextState, message, kind = '') {
  state = nextState;
  button.disabled = nextState !== 'idle';
  buttonLabel.textContent = nextState === 'choosing'
    ? '请选择 HTML…'
    : nextState === 'selected' ? '正在打开编辑器…' : '添加 Deck HTML';
  status.textContent = message;
  status.dataset.kind = kind;
}

button.addEventListener('click', async () => {
  if (state !== 'idle') return;
  setState('choosing', '系统文件选择器已打开', 'working');
  try {
    const response = await fetch(`/api/choose-deck?token=${encodeURIComponent(token)}`, {
      method:'POST',
      headers:{ accept:'application/json' },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '无法添加 Deck HTML');
    if (result.status === 'cancelled') {
      setState('idle', '已取消，可以重新添加');
      return;
    }
    if (result.status !== 'selected' || !result.editorUrl) {
      throw new Error('编辑器没有返回有效地址');
    }
    setState('selected', `已锁定 ${result.deckName}，正在打开编辑器`, 'working');
    window.location.replace(result.editorUrl);
  } catch (error) {
    setState('idle', error.message || '添加失败，请重试', 'error');
  }
});

window.addEventListener('pagehide', () => {
  if (state === 'selected') return;
  navigator.sendBeacon(`/api/close?token=${encodeURIComponent(token)}`);
});
