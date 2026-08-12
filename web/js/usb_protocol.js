// WebUSB Protocol Handler for MicroTester

const MICROTESTER_VID = 0xCAFE; // Default TinyUSB VID

// Protocol constants (mirror protocol.h)
const CMD_VOLT_START    = 0x10;
const CMD_VOLT_STOP     = 0x11;
const CMD_VOLT_SET_BIAS = 0x14;
const CMD_GET_VREF      = 0x20;
const CMD_OSC_START     = 0x12;
const CMD_OSC_STOP    = 0x13;
const CMD_SIG_START   = 0x30;
const CMD_SIG_STOP    = 0x31;
const CMD_SIGMA_DELTA_START = 0x32;
const CMD_SIGMA_DELTA_STOP  = 0x33;
const CMD_SIGMA_DELTA_DATA  = 0x34;
const CMD_LOGIC_START = 0x40;
const CMD_LOGIC_STOP  = 0x41;
const CMD_COMP_TEST  = 0x50;
const CMD_COMP_STOP  = 0x51;

const PKT_VOLTMETER_DATA     = 0x10;
const PKT_OSCILLOSCOPE_DATA  = 0x12;
const PKT_VREF_DATA          = 0x20;
const PKT_LOGIC_DATA         = 0x40;
const PKT_COMP_RESULT        = 0x50;

class MicroTesterUSB {
    constructor() {
        this.device = null;
        this.endpointIn = null;
        this.endpointOut = null;
        this.onConnect = null;
        this.onDisconnect = null;
        this.isReading = false;
        
        // Multi-listener data routing
        this._dataListeners = [];

        // Legacy single callback support (voltmeter.js sets this)
        this.onData = null;

        // Listen for device disconnects
        if (navigator.usb) {
            navigator.usb.addEventListener('disconnect', event => {
                if (this.device === event.device) {
                    this.disconnect();
                }
            });
        }
    }

    /** Register a data listener. Returns an id for removal. */
    addDataListener(callback) {
        this._dataListeners.push(callback);
        return callback;
    }

    /** Remove a previously registered data listener. */
    removeDataListener(callback) {
        this._dataListeners = this._dataListeners.filter(cb => cb !== callback);
    }

    /** Internal: dispatch data to all listeners */
    _dispatchData(data) {
        if (this.onData) this.onData(data);
        for (const cb of this._dataListeners) {
            cb(data);
        }
    }

    async connect() {
        try {
            if (!navigator.usb) {
                alert("WebUSB is not supported in this browser. Please use Google Chrome, MS Edge, or Opera over HTTPS / localhost.");
                return false;
            }

            this.device = await navigator.usb.requestDevice({
                filters: [{ vendorId: MICROTESTER_VID }]
            });
            
            await this.device.open();
            
            // Auto-select configuration and interface
            if (this.device.configuration === null) {
                await this.device.selectConfiguration(1);
            }
            
            // Find Vendor Interface
            let interfaceNumber = -1;
            for (let iface of this.device.configuration.interfaces) {
                for (let alt of iface.alternates) {
                    if (alt.interfaceClass === 0xFF) { // Vendor specific class
                        interfaceNumber = iface.interfaceNumber;
                        break;
                    }
                }
            }

            if (interfaceNumber === -1) {
                throw new Error("No Vendor Specific interface found. Is TinyUSB WebUSB configured?");
            }

            await this.device.claimInterface(interfaceNumber);
            
            this.endpointIn = null;
            this.endpointOut = null;
            
            const alt = this.device.configuration.interfaces[interfaceNumber].alternate;
            for (let ep of alt.endpoints) {
                if (ep.direction === 'in') this.endpointIn = ep.endpointNumber;
                if (ep.direction === 'out') this.endpointOut = ep.endpointNumber;
            }

            // WebUSB control transfer to enable WebUSB CDC/Vendor
            await this.device.controlTransferOut({
                requestType: 'class',
                recipient: 'interface',
                request: 0x22, // Set Control Line State
                value: 0x01,   // DTR = 1
                index: interfaceNumber
            });

            console.log("MicroTester connected.");
            if (this.onConnect) this.onConnect();
            
            this.startReading();
            return true;
        } catch (error) {
            console.error("Connection failed: ", error);
            return false;
        }
    }

    async disconnect() {
        if (this.device) {
            this.isReading = false;
            try { await this.device.close(); } catch(e){}
            this.device = null;
            console.log("MicroTester disconnected.");
            if (this.onDisconnect) this.onDisconnect();
        }
    }

    async sendCommand(cmd, payload = new Uint8Array(0)) {
        if (!this.device || !this.endpointOut) return;
        
        // Protocol: [CMD (1)] [Length (1)] [Payload (N)]
        const buffer = new Uint8Array(2 + payload.length);
        buffer[0] = cmd;
        buffer[1] = payload.length;
        buffer.set(payload, 2);
        
        try {
            await this.device.transferOut(this.endpointOut, buffer);
        } catch (error) {
            console.error("Transfer out error: ", error);
        }
    }

    async startReading() {
        this.isReading = true;
        while (this.isReading && this.device) {
            try {
                const result = await this.device.transferIn(this.endpointIn, 8192);
                if (result.status === 'ok' && result.data.byteLength > 0) {
                    this._dispatchData(new Uint8Array(result.data.buffer));
                }
            } catch (error) {
                if(this.isReading) {
                    console.error("Transfer in error: ", error);
                    this.disconnect();
                }
            }
        }
    }
}

// Global instance
const microTester = new MicroTesterUSB();

// UI bindings for connect
document.addEventListener('DOMContentLoaded', () => {
    const btnConnect = document.getElementById('btnConnect');
    const statusText = document.getElementById('connText');
    const statusDot = document.getElementById('connDot');

    if(btnConnect) {
        btnConnect.addEventListener('click', async () => {
            if (microTester.device) {
                microTester.disconnect();
            } else {
                await microTester.connect();
            }
        });

        microTester.onConnect = () => {
            if(btnConnect) btnConnect.innerText = "Disconnect";
            if(statusText) statusText.innerText = "Connected";
            if(statusDot) {
                statusDot.classList.add('connected');
                statusDot.classList.remove('disconnected');
            }
        };

        microTester.onDisconnect = () => {
            if(btnConnect) btnConnect.innerText = "Connect USB";
            if(statusText) statusText.innerText = "Disconnected";
            if(statusDot) {
                statusDot.classList.remove('connected');
                statusDot.classList.add('disconnected');
            }
        };
    }
});
