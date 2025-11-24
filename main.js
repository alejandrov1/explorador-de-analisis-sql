const { app, BrowserWindow } = require('electron');
const path = require('path');

// Importar e iniciar el backend existente
// Esto ejecutará tu server/index.js y levantará el puerto 3000
require('./server/index.js');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    autoHideMenuBar: true,
    // Asegúrate de que exista favicon.ico en src o ajusta esta ruta
    icon: path.join(__dirname, 'dist/app/favicon.ico')
  });

  // Cargar el index.html generado por el build de Angular
  mainWindow.loadFile(path.join(__dirname, 'dist/app/index.html'));

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
  if (mainWindow === null) createWindow();
});