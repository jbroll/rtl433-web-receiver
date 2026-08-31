package com.rkroll.rtl433;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void load() {
        super.load();
        // Scope cleartext to the local network; see LocalNetworkWebViewClient.
        bridge.setWebViewClient(new LocalNetworkWebViewClient(bridge));
    }
}
