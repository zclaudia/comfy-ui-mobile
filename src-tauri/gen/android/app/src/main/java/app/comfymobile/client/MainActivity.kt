package app.comfymobile.client

import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // The app lives on tauri.localhost but talks to a cross-origin Gateway over
  // HTTPS; Android WebView drops the Gateway's SameSite=None session cookie
  // unless third-party cookies are explicitly accepted.
  //
  // Android WebView never resolves env(safe-area-inset-*), so content drawn
  // edge-to-edge ends up underneath the status bar (whose window also swallows
  // taps in that region) and the gesture navigation bar. Publish the real
  // insets as CSS custom properties that the stylesheet prefers over env().
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

    val applyForCurrentPage = { top: Int, bottom: Int ->
      webView.evaluateJavascript(
        "window.__statusBarInset='${top}px';window.__navBarInset='${bottom}px';" +
          "document.documentElement.style.setProperty('--status-bar-inset','${top}px');" +
          "document.documentElement.style.setProperty('--nav-bar-inset','${bottom}px');",
        null,
      )
    }
    val applyForFutureNavigations = { top: Int, bottom: Int ->
      WebViewCompat.addDocumentStartJavaScript(
        webView,
        "document.documentElement.style.setProperty('--status-bar-inset','${top}px');" +
          "document.documentElement.style.setProperty('--nav-bar-inset','${bottom}px');",
        setOf("*"),
      )
    }
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      // Insets arrive in physical pixels; CSS wants density-independent ones.
      val density = resources.displayMetrics.density
      val top = (insets.getInsets(
        WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout(),
      ).top / density).toInt()
      val bottom = (insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom / density).toInt()
      applyForCurrentPage(top, bottom)
      applyForFutureNavigations(top, bottom)
      ViewCompat.onApplyWindowInsets(view, insets)
    }
  }
}
