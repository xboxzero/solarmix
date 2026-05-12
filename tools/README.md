# solarmix sidecar tools

## leap_bridge

A tiny C program that reads from a local Ultraleap tracking service and POSTs
JSON hand frames to `sp-hub`'s `/leap-ingest`. The page consumes those frames
over its `/leap` WebSocket. Without the bridge, solarmix falls back to mouse.

### One-time install (Raspberry Pi 5, arm64)

Ultraleap publishes an official arm64 Pi build of their tracking service.

```bash
# Download (~340MB) and extract
mkdir -p /tmp/ultraleap && cd /tmp/ultraleap
curl -LO https://s3.eu-west-1.amazonaws.com/downloads.ultraleap.com/software/tracking-software/6.2.0/tracking-software-raspberry-pi-os-6.2.0.tar.gz
tar xzf tracking-software-raspberry-pi-os-6.2.0.tar.gz
cd ultraleap-hand-tracking-service_6.2.0.0-c98d293a-arm64

# Install (writes /opt/ultraleap, systemd unit, and udev rule for the device)
sudo ./install_gemini.sh
```

After install, `libtrack_server` runs as a systemd service and the Leap is
accessible without root.

### Build the bridge

```bash
sudo apt install -y libcurl4-openssl-dev
SDK=/opt/ultraleap/LeapSDK   # or your extracted path
gcc -O2 -o leap_bridge tools/leap_bridge.c \
    -I"$SDK/include" -L"$SDK/lib" -lLeapC -lcurl \
    -Wl,-rpath,"$SDK/lib"
```

### Run

```bash
SP_HUB_URL=http://127.0.0.1:8855/leap-ingest ./leap_bridge
```

Open `http://<pi>:8855/` — the `leap` dot in the top-left HUD should go live,
and hand X/Y/Z values should track your hand.
