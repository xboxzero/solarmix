// leap_bridge — minimal sidecar.
//
// Connects to a running Ultraleap tracking service (libtrack_server) via the
// Ultraleap LeapC API, polls tracking events, and POSTs one JSON line per
// frame to sp-hub's solarmix /leap-ingest endpoint. The frame format:
//
//   {"type":"frame","hands":[{"position":[x,y,z],"pinch":p,"grab":g}]}
//
// Coordinates are normalized: X,Z in -1..1 (from device-local mm divided by 200),
// Y in 0..1 (height above device, divided by 400 mm).
//
// Build (on the Pi, after extracting ultraleap-hand-tracking-service tarball):
//
//   SDK=/tmp/ultraleap/ultraleap-hand-tracking-service_6.2.0.0-c98d293a-arm64/LeapSDK
//   gcc -O2 -o leap_bridge tools/leap_bridge.c \
//       -I"$SDK/include" -L"$SDK/lib" -lLeapC -lcurl \
//       -Wl,-rpath,"$SDK/lib"
//
// Run (sp-hub must be reachable at SP_HUB_URL):
//
//   SP_HUB_URL=http://127.0.0.1:8855/leap-ingest ./leap_bridge
//
// USB perms note: the Leap device needs udev access. Easiest fix is to run
// the official `install_gemini.sh` once with sudo — it installs the systemd
// unit AND the udev rule. Then the user-space libtrack_server picks up the
// device cleanly and this bridge can read it without root.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>

#include "LeapC.h"
#include <curl/curl.h>

static volatile int run = 1;
static void onint(int s) { (void)s; run = 0; }

static size_t curl_discard(void* p, size_t s, size_t n, void* u) {
    (void)p; (void)u; return s * n;
}

static void post_frame(CURL* curl, const char* url, const char* body) {
    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(body));
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 200L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_discard);
    curl_easy_perform(curl);
}

int main(void) {
    const char* url = getenv("SP_HUB_URL");
    if (!url) url = "http://127.0.0.1:8855/leap-ingest";

    signal(SIGINT, onint);
    signal(SIGTERM, onint);

    LEAP_CONNECTION conn = NULL;
    if (LeapCreateConnection(NULL, &conn) != eLeapRS_Success) {
        fprintf(stderr, "LeapCreateConnection failed\n");
        return 1;
    }
    if (LeapOpenConnection(conn) != eLeapRS_Success) {
        fprintf(stderr, "LeapOpenConnection failed\n");
        return 1;
    }

    curl_global_init(CURL_GLOBAL_DEFAULT);
    CURL* curl = curl_easy_init();
    if (!curl) { fprintf(stderr, "curl init failed\n"); return 1; }

    fprintf(stderr, "leap_bridge: posting to %s\n", url);

    LEAP_CONNECTION_MESSAGE msg;
    char body[512];
    while (run) {
        if (LeapPollConnection(conn, 200, &msg) != eLeapRS_Success) continue;
        if (msg.type != eLeapEventType_Tracking) continue;
        const LEAP_TRACKING_EVENT* ev = msg.tracking_event;
        if (!ev || ev->nHands == 0) {
            snprintf(body, sizeof(body), "{\"type\":\"frame\",\"hands\":[]}");
            post_frame(curl, url, body);
            continue;
        }
        const LEAP_HAND* h = &ev->pHands[0];
        // device-local mm; normalize for the page.
        float x = h->palm.position.x / 200.0f;
        float y = h->palm.position.y / 400.0f; // height
        float z = h->palm.position.z / 200.0f;
        if (x < -1) x = -1; if (x > 1) x = 1;
        if (y < 0) y = 0; if (y > 1) y = 1;
        if (z < -1) z = -1; if (z > 1) z = 1;
        float pinch = h->pinch_strength;
        float grab  = h->grab_strength;
        snprintf(body, sizeof(body),
            "{\"type\":\"frame\",\"hands\":[{\"position\":[%.3f,%.3f,%.3f],\"pinch\":%.3f,\"grab\":%.3f}]}",
            x, y, z, pinch, grab);
        post_frame(curl, url, body);
    }

    curl_easy_cleanup(curl);
    curl_global_cleanup();
    LeapCloseConnection(conn);
    LeapDestroyConnection(conn);
    return 0;
}
