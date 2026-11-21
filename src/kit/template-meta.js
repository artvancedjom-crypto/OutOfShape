// Descriptions of the built-in plant templates and the rules that let the PDF matcher
// recognise them in documents. (The plants themselves are built in templates.js.)
export const TEMPLATE_META = {
  motor: {
    id: "motor", name: "Motor Start/Stop with Interlocks", difficulty: "Beginner", minutes: 10, icon: "⚙️",
    summary: "The \"hello world\" of PLCs: a seal-in (latching) circuit for a motor contactor with a normally-closed stop button, emergency stop and thermal overload.",
    match: {
      keywords: [["motor", 2], ["start", 1], ["stop", 1], ["seal-in", 4], ["self-holding", 4], ["latching", 2], ["holding contact", 3], ["contactor", 3], ["overload", 3], ["emergency stop", 3], ["e-stop", 3], ["interlock", 2], ["dol", 2], ["direct on line", 3], ["pilot light", 2], ["normally closed", 1.5]],
      params: [
        { key: "load", re: /load[^.\d]{0,20}(\d{1,3})\s*%/i },
        { key: "trip", re: /trip[^.\d]{0,25}(\d{2,3})\s*°?\s*c\b/i },
      ],
    },
    params: [{ key: "load", label: "Mechanical load", min: 0, max: 150, unit: "%" }, { key: "trip", label: "Overload trip temperature", min: 60, max: 140, unit: "°C" }],
  },
  traffic: {
    id: "traffic", name: "Traffic Light Intersection", difficulty: "Intermediate", minutes: 25, icon: "🚦",
    summary: "A four-way intersection with car-detection loops, a pedestrian push button and night-mode flashing. Program the phase sequence with timers and a state machine.",
    match: {
      keywords: [["traffic light", 5], ["traffic signal", 5], ["intersection", 3], ["junction", 2], ["pedestrian", 2], ["crosswalk", 2], ["amber", 2], ["yellow", 1], ["red", 0.5], ["green", 0.5], ["phase", 1], ["night mode", 2], ["flashing", 1], ["vehicle detection", 2], ["induction loop", 3], ["crossing", 1]],
      params: [
        { key: "green", re: /green[^.\d]{0,30}?(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)/i },
        { key: "yellow", re: /(?:yellow|amber)[^.\d]{0,30}?(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)/i },
      ],
    },
    params: [{ key: "green", label: "Green time", min: 3, max: 30, unit: "s" }, { key: "yellow", label: "Yellow time", min: 1, max: 6, unit: "s" }],
  },
  tank: {
    id: "tank", name: "Tank Level Control", difficulty: "Intermediate", minutes: 20, icon: "🛢️",
    summary: "Fill a storage tank with a pump and keep the level inside a band while a consumer draws water. Analog level transmitter, discrete level switches, auto/manual mode and alarms.",
    match: {
      keywords: [["tank", 3], ["level control", 5], ["liquid level", 4], ["water level", 4], ["level sensor", 3], ["level switch", 3], ["float switch", 3], ["pump", 2], ["fill", 1], ["overflow", 2], ["reservoir", 2], ["hysteresis", 2], ["valve", 1], ["high level", 2], ["low level", 2], ["dry run", 2]],
      params: [
        { key: "capacity", re: /(?:capacity|volume)[^.\d]{0,25}?(\d+(?:[.,]\d+)?)\s*(?:l\b|liters|litres)/i },
        { key: "capacity", re: /(\d+(?:\.\d+)?)\s*m(?:3|³)/i, scale: 1000 },
        { key: "inflow", re: /(?:pump|inflow|inlet)[^.\d]{0,30}?(\d+(?:\.\d+)?)\s*(?:l\/s|liters? per second)/i },
        { key: "outflow", re: /(?:outflow|outlet|consum\w*|drain)[^.\d]{0,30}?(\d+(?:\.\d+)?)\s*(?:l\/s|liters? per second)/i },
        { key: "spLow", re: /(?:start|low(?:er)?)[^.\d]{0,30}?(\d{1,2})\s*%/i },
        { key: "spHigh", re: /(?:stop|high(?:er)?|upper)[^.\d]{0,30}?(\d{2})\s*%/i },
      ],
    },
    params: [{ key: "spLow", label: "Start level", min: 5, max: 60, unit: "%" }, { key: "spHigh", label: "Stop level", min: 40, max: 95, unit: "%" }, { key: "capacity", label: "Tank capacity", min: 200, max: 5000, unit: "L" }, { key: "inflow", label: "Pump flow", min: 5, max: 200, unit: "L/s" }, { key: "outflow", label: "Consumer flow (full tank)", min: 0, max: 150, unit: "L/s" }],
  },
  conveyor: {
    id: "conveyor", name: "Conveyor Sorting Station", difficulty: "Intermediate", minutes: 25, icon: "📦",
    summary: "Boxes of two heights travel on a belt. A height photo-eye detects tall boxes; a pneumatic pusher must divert them to the side chute while small boxes continue. Uses edge detection, latches and counters.",
    match: {
      keywords: [["conveyor", 4], ["sorting", 4], ["sort", 2], ["belt", 2], ["pusher", 3], ["diverter", 3], ["photo-eye", 3], ["photoelectric", 3], ["light barrier", 3], ["proximity sensor", 2], ["boxes", 1], ["parts", 0.5], ["cylinder", 1], ["reject", 2], ["height", 1], ["counter", 1]],
      params: [
        { key: "interval", re: /every\s+(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)/i },
        { key: "speed", re: /(?:belt|conveyor)\s+speed[^.\d]{0,20}?(\d+(?:\.\d+)?)/i },
      ],
    },
    params: [{ key: "speed", label: "Belt speed", min: 1, max: 8, unit: "studs/s" }, { key: "interval", label: "Box interval", min: 2, max: 10, unit: "s" }],
  },
  bottling: {
    id: "bottling", name: "Bottling Line (Fill & Cap)", difficulty: "Advanced", minutes: 35, icon: "🍾",
    summary: "An indexing bottling machine: bottles stop under the filler and capper, which work in parallel. Sequence control with a step chain, timers, level sensing and batch counting.",
    match: {
      keywords: [["bottle", 4], ["bottling", 5], ["filling", 3], ["filler", 3], ["capping", 4], ["capper", 4], ["cap", 1], ["indexing", 2], ["batch", 2], ["fill level", 2], ["sequence", 1], ["step chain", 2], ["grafcet", 2], ["sfc", 1]],
      params: [
        { key: "capTime", re: /cap\w*[^.\d]{0,30}?(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)/i },
      ],
    },
    params: [{ key: "capTime", label: "Capping time", min: 0.3, max: 3, unit: "s" }],
  },
  elevator: {
    id: "elevator", name: "3-Floor Elevator", difficulty: "Advanced", minutes: 40, icon: "🛗",
    summary: "A three-storey lift with landing call buttons, floor position sensors, door limit switches and overtravel limits. Ride it in first-person mode!",
    match: {
      keywords: [["elevator", 5], ["lift", 3], ["floor", 1.5], ["storey", 2], ["car", 0.5], ["landing", 2], ["call button", 3], ["hoist", 2], ["door", 1], ["limit switch", 2], ["overtravel", 2]],
      params: [
        { key: "door", re: /door[^.\d]{0,30}?(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)/i },
      ],
    },
    params: [{ key: "door", label: "Door dwell", min: 1, max: 8, unit: "s" }],
  },
};
