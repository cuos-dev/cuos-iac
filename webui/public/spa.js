// Timer-Animation für SVG-Kreis
document.addEventListener('DOMContentLoaded', function() {
  const duration = document.querySelector('.timer-svg').dataset.iacPollInterval || 21600; // 6h
  // Hole das letzte Update aus einem Data-Attribut des SVG oder eines versteckten Elements
  const lastUpdateStr = document.querySelector('.timer-svg').dataset.lastUpdate;
  const iacStateStr = document.querySelector('.timer-svg').dataset.iacState;
  let lastUpdate = lastUpdateStr ? new Date(lastUpdateStr) : new Date();

  const fg = document.querySelector('.timer-fg');
  const text = document.querySelector('.timer-text');
  let timerInterval;
  let counter = 0;
  let refreshTimer;
  function updateTimer() {
    let now = new Date();
    let elapsed = Math.floor((now - lastUpdate) / 1000);
    let remaining = Math.max(duration - elapsed, 0);

    if (remaining > 0 && iacStateStr !== "updating") {
      const min = String(Math.floor(remaining / 60)).padStart(2, '0');
      const sec = String(remaining % 60).padStart(2, '0');
      text.textContent = `${min}:${sec}`;
      const percent = remaining / duration;
      fg.style.strokeDashoffset = 628/4;
      fg.style.strokeDasharray = 628 * (percent) + " " + 628 * (1 - percent);
    } else {
      if (!refreshTimer) {
        refreshTimer = setTimeout(function() {
          location.href = "./";
        }, 10*1000);
      }
      counter++;
      text.textContent = ``;
      fg.style.strokeDashoffset = counter * 300;
      fg.style.strokeDasharray = "180 448";
    }
  }
  timerInterval = setInterval(updateTimer, 490);
  updateTimer();
});
