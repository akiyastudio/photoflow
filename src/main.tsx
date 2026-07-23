import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { AppDialogProvider } from './components/AppDialogProvider.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppDialogProvider>
      <App />
    </AppDialogProvider>
  </React.StrictMode>,
)
