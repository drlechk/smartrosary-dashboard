import { $, safeNum } from './utils.js';

let barWindow, donutSets, partsChart;

const THEME_PALETTES = {
  dark: {
    axisTick: '#cfe4ff',
    axisGrid: '#1a2733',
    legendLabel: '#eaf0f6',
    donutBorder: '#0b0f14',
  },
  light: {
    axisTick: '#1f2937',
    axisGrid: '#d4deeb',
    legendLabel: '#0f172a',
    donutBorder: '#ffffff',
  },
};

function currentThemePalette(mode) {
  if (mode === 'light') return THEME_PALETTES.light;
  if (mode === 'dark') return THEME_PALETTES.dark;
  return document.body.classList.contains('theme-light') ? THEME_PALETTES.light : THEME_PALETTES.dark;
}

export function initCharts() {
  const ctxBarEl   = $('barWindow');
  const ctxDonutEl = $('donutSets');
  const ctxPartsEl = $('partsChart');

  const ctxBar   = ctxBarEl ? ctxBarEl.getContext('2d') : null;
  const ctxDonut = ctxDonutEl ? ctxDonutEl.getContext('2d') : null;
  const ctxParts = ctxPartsEl ? ctxPartsEl.getContext('2d') : null;

  if (!ctxDonut || !ctxParts) {
    console.warn('initCharts: required canvases missing, aborting');
    return;
  }

  if (ctxBar) {
    barWindow = new Chart(ctxBar, {
      type: 'bar',
      data: {
        labels: ['Bead','Decade','Rosary','Chaplet'],
        datasets: [{ label:'Avg (s)', data:[0,0,0,0], backgroundColor:['#66b2ff','#66b2ff','#66b2ff','#8b5a2b'] }]
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        scales:{
          x:{ stacked:true, grid:{ color:'#1a2733' }, ticks:{ color:'#cfe4ff' } },
          y:{ stacked:true, beginAtZero:true, grid:{ color:'#1a2733' }, ticks:{ color:'#cfe4ff', precision:0 } }
        },
        plugins:{ legend:{ display:false } }
      }
    });
  } else {
    barWindow = null;
  }

  donutSets = new Chart(ctxDonut, {
    type: 'doughnut',
    data: {
      labels: ['None','Joyful','Sorrowful','Glorious','Luminous','Chaplet'],
      datasets: [{
        data: [0,0,0,0,0,0],
        backgroundColor:['#808080','#3399ff','#cc0000','#00cc00','#ffcc00','#8B4513'],
        borderWidth:0
      }]
    },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'bottom', labels:{ color:'#eaf0f6' } } }, cutout:'60%' }
  });

  const shades = {
    none:['#9e9e9e','#8f8f8f','#808080','#717171','#626262'],
    joyful:['#99ccff','#66b2ff','#3399ff','#1a7fd6','#0066cc'],
    sorrowful:['#ff6666','#ff3333','#cc0000','#990000','#730000'],
    glorious:['#66ff66','#33e633','#00cc00','#00a300','#007a00'],
    luminous:['#ffe680','#ffdb4d','#ffcc00','#e6b800','#cc9a00'],
  };
  partsChart = new Chart(ctxParts, {
    type:'bar',
    data: {
      labels:['None','Joyful','Luminous','Sorrowful','Glorious'],
      datasets:[
        {label:'I',  data:[0,0,0,0,0], backgroundColor:[shades.none[0],shades.joyful[0],shades.luminous[0],shades.sorrowful[0],shades.glorious[0]]},
        {label:'II', data:[0,0,0,0,0], backgroundColor:[shades.none[1],shades.joyful[1],shades.luminous[1],shades.sorrowful[1],shades.glorious[1]]},
        {label:'III',data:[0,0,0,0,0], backgroundColor:[shades.none[2],shades.joyful[2],shades.luminous[2],shades.sorrowful[2],shades.glorious[2]]},
        {label:'IV', data:[0,0,0,0,0], backgroundColor:[shades.none[3],shades.joyful[3],shades.luminous[3],shades.sorrowful[3],shades.glorious[3]]},
        {label:'V',  data:[0,0,0,0,0], backgroundColor:[shades.none[4],shades.joyful[4],shades.luminous[4],shades.sorrowful[4],shades.glorious[4]]},
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:'bottom', labels:{ color:'#eaf0f6' } } },
      scales:{
        x:{ stacked:true, grid:{ color:'#1a2733' }, ticks:{ color:'#cfe4ff' } },
        y:{ stacked:true, beginAtZero:true, grid:{ color:'#1a2733' }, ticks:{ color:'#cfe4ff', precision:0 } }
      }
    }
  });

  applyChartTheme();
}

export function applyChartTheme(mode) {
  const palette = currentThemePalette(mode);

  const updateScales = (chart) => {
    if (!chart?.options?.scales) return;
    const { scales } = chart.options;
    for (const axisKey of Object.keys(scales)) {
      const axis = scales[axisKey];
      if (axis.grid) axis.grid.color = palette.axisGrid;
      if (axis.ticks) axis.ticks.color = palette.axisTick;
    }
  };

  if (barWindow) {
    updateScales(barWindow);
    barWindow.update('none');
  }
  if (partsChart) {
    updateScales(partsChart);
    if (partsChart.options?.plugins?.legend?.labels) {
      partsChart.options.plugins.legend.labels.color = palette.legendLabel;
    }
    partsChart.update('none');
  }
  if (donutSets) {
    if (donutSets.options?.plugins?.legend?.labels) {
      donutSets.options.plugins.legend.labels.color = palette.legendLabel;
    }
    donutSets.update('none');
  }
}

export function setChartLabels(L) {
  if (barWindow?.data) {
    barWindow.data.labels = [L.chartBead, L.chartDecade, L.chartRosary, L.chartChaplet];
    barWindow.update();
  }
  if (donutSets?.data) {
    donutSets.data.labels = L.sets.slice();
    donutSets.update();
  }
  if (partsChart?.data) {
    partsChart.data.labels = [L.sets[0], L.sets[1], L.sets[4], L.sets[2], L.sets[3]];
    partsChart.update();
  }
}

export function updateAverages({ avgBeadMs=0, avgDecadeMs=0, avgRosaryMs=0, avgChapletMs=0 }) {
  if (!barWindow) return;
  barWindow.data.datasets[0].data = [
    safeNum(avgBeadMs,0)/1000,
    safeNum(avgDecadeMs,0)/1000,
    safeNum(avgRosaryMs,0)/1000,
    safeNum(avgChapletMs,0)/1000
  ];
  barWindow.update();
}

export function updateDonut({ none=0, joyful=0, sorrowful=0, glorious=0, luminous=0, chaplet=0 }) {
  if (!donutSets) return;
  donutSets.data.datasets[0].data = [none, joyful, sorrowful, glorious, luminous, chaplet];
  donutSets.update();
}

const PART_WEIGHT = 0.2;
export function updateParts(setsParts) {
  if (!setsParts || !partsChart) return;

  // order: none, joyful, luminous, sorrowful, glorious
  const order = ['none','joyful','luminous','sorrowful','glorious'];

  // Build data for I..V (datasets) across the 5 sets (x axis),
  // scaling each mystery part by 0.2
  const dataByPart = [0,1,2,3,4].map(()=>[0,0,0,0,0]);

  order.forEach((name, si) => {
    const arr = setsParts[name] || [0,0,0,0,0];
    for (let p = 0; p < 5; p++) {
      const raw = Number(arr[p] || 0);
      dataByPart[p][si] = raw * PART_WEIGHT;   // ← scale here
    }
  });

  for (let p = 0; p < 5; p++) {
    partsChart.data.datasets[p].data = dataByPart[p];
  }
  partsChart.update();
}
