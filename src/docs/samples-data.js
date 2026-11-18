// Text of the built-in sample documents (kept separate so it can be unit-tested in Node).
export const SAMPLES = [
  {
    name: 'Lab Sheet - Traffic Light Controller',
    text: `# Lab 4: Traffic Light Controller (PLC)

## Task
Program a PLC to control a four-way traffic light intersection. Each direction (North-South and East-West) has a red, amber (yellow) and green lamp.

## Requirements
- The green phase lasts 12 s for each direction.
- The amber phase lasts 3 s, followed by a short all-red clearance phase.
- Induction loops detect vehicles waiting at the red light; extend the green when the cross street is empty.
- A pedestrian push button requests the crossing. The walk signal is shown during the East-West green phase.
- Night mode: both directions show flashing yellow.

## Hints
Use a TON timer as step timer and a CASE state machine in Structured Text, or a step chain in ladder logic.
`,
  },
  {
    name: 'Experiment - RC Time Constant',
    text: `# Experiment 2: Charging and Discharging a Capacitor

## Setup
Build an RC circuit on the breadboard: a 9 V battery supply, a resistor R = 22 kOhm and an electrolytic capacitor C = 47 uF. A changeover switch selects charging or discharging.

## Procedure
1. Discharge the capacitor completely.
2. Switch to charging and record the capacitor voltage every second with the multimeter.
3. Determine the time constant tau = R * C from the time at which the voltage reaches 63% of the supply voltage.
4. Repeat for discharging and plot both exponential curves.

## Questions
- How long does it take until the capacitor is considered fully charged (5 tau)?
- How does doubling the resistor change the time constant?
`,
  },
  {
    name: 'Spec - Water Tank Level Control',
    text: `# Functional Specification: Storage Tank Level Control

The storage tank has a capacity of 2000 L. A feed pump with an inflow of 80 L/s fills the tank from the reservoir. The consumer draws water through outlet valve V1 with an outflow of up to 45 L/s.

## Control requirements (PLC)
- Automatic mode: start the pump at 25 % level and stop the pump at 85 % level (two-point control with hysteresis).
- A high-high level switch at 95 % must stop the pump in all modes to prevent overflow.
- A low level switch (dry run protection) closes the outlet valve when the tank is nearly empty.
- Manual mode: the pump can be jogged with a push button.
- Alarm beacon flashes on high-high or low level.

The level transmitter LT1 provides an analog level signal 0-100 %.
`,
  },
  {
    name: 'Handout - Basic Electronics (LED + Transistor)',
    pages: [
      `# Part A: Light Emitting Diode

A red LED is connected to a 12 V supply through a series resistor of 470 Ohm. The forward voltage of a red LED is about 2 V and the recommended forward current is 20 mA.

Calculate the current-limiting resistor: R = (Vs - Vf) / If. What happens if the resistor is too small?`,
      `# Part B: Transistor as a Switch

An NPN transistor (BC547, hFE = 200) switches a green LED. The base resistor RB = 22 kOhm is driven from a microcontroller output with Vin = 5 V. The collector resistor RC = 330 Ohm limits the LED current, supply Vcc = 9 V.

Check that the transistor is in saturation: the collector-emitter voltage must be below 0.2 V. Explain cut-off, active region and saturation.`,
    ],
  },
  {
    name: 'Worksheet - Motor Control with Seal-in',
    text: `# Worksheet: Direct On Line Motor Starter

A three-phase motor is controlled by contactor K1. The START push button (normally open) energises K1, and a holding contact (seal-in / self-holding) keeps the motor running after START is released.

The STOP push button is normally closed. The emergency stop and the thermal overload relay F1 are also wired as normally closed contacts and form an interlock. The overload trips at 110 C winding temperature when the load exceeds 120 %.

A green pilot light shows that the motor is running, a red pilot light indicates a fault.

Draw the ladder diagram and test it on the PLC.
`,
  },
];
