#!/usr/bin/env bash
# A stand-in `tailscale` for the documentation screenshots, so they show a made-up tailnet
# (laptop.tail1234.ts.net) instead of a real one. State lives in $FAKE_TS_STATE.
state="${FAKE_TS_STATE:?}"
served() { [ -f "$state/served" ]; }
port="${FAKE_TS_PORT:-12700}"

case "$1 $2" in
  "version "*) echo "1.90.2" ;;
  "status --json")
    cat <<'EOF'
{"BackendState":"Running","Self":{"DNSName":"laptop.tail1234.ts.net.","HostName":"laptop","TailscaleIPs":["100.101.102.103"]},
 "MagicDNSSuffix":"tail1234.ts.net","CurrentTailnet":{"Name":"you@example.com","MagicDNSSuffix":"tail1234.ts.net","MagicDNSEnabled":true}}
EOF
    ;;
  "status "*)
    cat <<'EOF'
100.101.102.103  laptop   you@  linux  -
100.88.12.40     iphone   you@  iOS    active; direct 192.168.1.23:41641, tx 51872 rx 90288
100.92.7.15      macbook  you@  macOS  -
EOF
    ;;
  "serve status")
    if [ "$3" = "--json" ]; then
      if served; then
        echo '{"TCP":{"443":{"HTTPS":true}},"Web":{"laptop.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:'"$port"'"}}}}}'
      else
        echo '{}'
      fi
    elif served; then
      printf 'https://laptop.tail1234.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:%s\n' "$port"
    else
      echo "No serve config"
    fi
    ;;
  "serve --bg")
    touch "$state/served"
    printf 'Available within your tailnet:\n\nhttps://laptop.tail1234.ts.net/\n|-- proxy http://127.0.0.1:%s\n\nServe started and running in the background.\nTo disable the proxy, run: tailscale serve --https=443 off\n' "$3"
    ;;
  *) echo "fake tailscale: $*" >&2; exit 1 ;;
esac
