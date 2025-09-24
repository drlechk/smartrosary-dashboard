export const UUID = {
  OTA_SVC:        '12345678-1234-5678-1234-56789abcdef0',
  INFO_STATS:     'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e1001',
  INFO_SETTINGS:  'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e1002',
  INFO_CTRL:      'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e10ff',
  INFO_PARTS:     'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e1003',
  TOUCH_CHAR:     '12345678-1234-5678-1234-56789abcdea1',
  KEYS_CHAR:      '12345678-1234-5678-1234-56789abcdea2',
  AUTH_INFO:      '8b40f200-78e7-4a6b-b1d3-6b5f3a10a201',
  AUTH_CTRL:      '8b40f201-78e7-4a6b-b1d3-6b5f3a10a201',
  STATUS:         '12345678-1234-5678-1234-56789abcdef2',
};

export const OPCODE = {
  OP_SET_PREF:   0x50,
  OP_SET_STAT:   0x53,
  OP_REST_DONE:  0x55,
  OP_REST_BEGIN: 0x54,
  HELLO_WEB:     0x41,
  AUTH_BEGIN:    0x60,
  AUTH_SET:      0x61,
  AUTH_COMMIT:   0x62,
  KEYS_HELLO:    0x64
};

export const LV = { LEFT:2, RIGHT:1, TOP:8, BOTTOM:4 };
export const CMD_CENTER = 16;