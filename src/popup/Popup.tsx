/**
 * Popup —— manifest 中 action 默认点击会直接打开侧边栏（见 background）。
 * 此弹窗作为后备入口保留：当宿主 Chrome 不支持 setPanelBehavior 时使用。
 */
export function Popup() {
  const openPanel = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      try {
        await chrome.sidePanel.open({ tabId: tab.id });
        window.close();
      } catch {
        /* ignore */
      }
    }
  };

  return (
    <div className="popup">
      <h1>飞书文档导出助手</h1>
      <p>在飞书文档页面打开侧边栏即可一键导出。</p>
      <button onClick={openPanel}>打开侧边栏</button>
    </div>
  );
}
