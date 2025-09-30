import { $, safeNum } from './utils.js';

let barWindow, donutSets, partsChart;

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
        borderColor:'#0b0f14', borderWidth:2
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

export function updateParts(setsParts) {
  if (!setsParts || !partsChart) return;
  const order = ['none','joyful','luminous','sorrowful','glorious'];
  const dataByPart = [0,1,2,3,4].map(()=>[0,0,0,0,0]);
  order.forEach((name, si) => {
    const arr = setsParts[name] || [0,0,0,0,0];
    for (let p=0;p<5;p++) dataByPart[p][si] = Number(arr[p]||0);
  });
  for (let p=0;p<5;p++) partsChart.data.datasets[p].data = dataByPart[p];
  partsChart.update();
}
