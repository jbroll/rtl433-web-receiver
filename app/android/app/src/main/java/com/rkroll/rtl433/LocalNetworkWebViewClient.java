package com.rkroll.rtl433;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.net.InetAddress;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Refuses a plain-http request unless its host is local; network security
 * config can't express that scope. See app/docs/development.md#local-network-cleartext.
 */
public class LocalNetworkWebViewClient extends BridgeWebViewClient {

    private static final Pattern IPV4_LITERAL = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");

    public LocalNetworkWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if ("http".equalsIgnoreCase(url.getScheme()) && !isLocalHost(url.getHost())) {
            return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
        }
        return super.shouldInterceptRequest(view, request);
    }

    private static boolean isLocalHost(String host) {
        if (host == null || host.isEmpty()) {
            return false;
        }
        String h = host.toLowerCase(Locale.ROOT);
        if (h.equals("localhost") || h.endsWith(".local")) {
            return true;
        }
        boolean looksNumeric = IPV4_LITERAL.matcher(h).matches() || h.contains(":");
        if (!looksNumeric) {
            // A non-".local" hostname (e.g. someremotehost.com) is never local.
            return false;
        }
        try {
            // InetAddress.getByName on a numeric literal only parses it; it
            // never performs a DNS lookup, so this stays offline.
            InetAddress addr = InetAddress.getByName(h);
            return addr.isLoopbackAddress() || addr.isLinkLocalAddress() || addr.isSiteLocalAddress();
        } catch (Exception e) {
            return false;
        }
    }
}
