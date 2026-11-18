// VideoHub in its own window on the NVIDIA GPU.
// Some PCs run Edge without hardware acceleration (for example a company policy HardwareAccelerationModeEnabled=0), so the
// live preview runs on the CPU and stutters. A desktop shell picks its GPU at launch, whatever a browser's settings are.
// The policy itself is NOT changed.
const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
// keep playing smoothly when another window covers it for a moment
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// sound starts with the preview's Play button without an extra click
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const URL = process.env.VIDEOHUB_URL || 'http://127.0.0.1:7788/';

app.whenReady().then(async () => {
  if (process.env.VH_GPU_REPORT) {
    // diagnostic: write which GPU and which features are hardware-accelerated, then quit
    const info = await app.getGPUInfo('complete').catch((e) => ({ error: String(e) }));
    const out = { features: app.getGPUFeatureStatus(), devices: info.gpuDevice, renderer: info.auxAttributes && info.auxAttributes.glRenderer };
    fs.writeFileSync(path.join(__dirname, 'gpu-report.json'), JSON.stringify(out, null, 1));
    app.quit();
    return;
  }
  const win = new BrowserWindow({
    width: 1600, height: 1000, autoHideMenuBar: true, backgroundColor: '#111214', title: 'VideoHub (GPU)',
    webPreferences: { backgroundThrottling: false },
  });
  win.maximize();
  win.loadURL(URL);
  // links that leave VideoHub open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:7788')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.on('window-all-closed', () => app.quit());
