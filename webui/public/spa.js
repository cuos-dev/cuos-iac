let counter = 0;
let refreshTimer;

function state_idle(text, fg, remaining, duration) {
  const hour = String(Math.floor(remaining / 3600)).padStart(2, '0');
  const min = String(Math.floor(remaining / 60) % 60).padStart(2, '0');
  const sec = String(remaining % 60).padStart(2, '0');
  text.textContent = (hour !== "00" ? `${hour}:`:``) + `${min}:${sec}`;
  const percent = remaining / duration;
  fg.style.strokeDashoffset = 628/4;
  fg.style.strokeDasharray = 628 * (percent) + " " + 628 * (1 - percent);
}

function state_updating(text, fg) {
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


function state_manualupdates(text, fg) {
  text.textContent = `∞`;
  fg.style.strokeDashoffset = 628/4;
  fg.style.strokeDasharray = "0 628";
  fg.style.display = "none";
}

// Timer-Animation für SVG-Kreis
document.addEventListener('DOMContentLoaded', function() {
  const fg = document.querySelector('.timer-fg');
  const text = document.querySelector('.timer-text');

  const duration = document.querySelector('.timer-svg').dataset.iacPollInterval || 21600; // 6h
  const iacStateStr = document.querySelector('.timer-svg').dataset.iacState;
  const iacManualUpdates = document.querySelector('.timer-svg').dataset.iacManualUpdates;
  const lastUpdateStr = document.querySelector('.timer-svg').dataset.lastUpdate;
  let lastUpdate = lastUpdateStr ? new Date(lastUpdateStr) : new Date();

  function updateTimer() {
    let now = new Date();
    let elapsed = Math.floor((now - lastUpdate) / 1000);
    let remaining = Math.max(duration - elapsed, 0);

    if (iacStateStr === "updating") {
      state_updating(text, fg);
    } else if (iacManualUpdates == "true") {
      state_manualupdates(text, fg);
    } else if (remaining <= 0) {
      state_updating(text, fg);
    } else {
      state_idle(text, fg, remaining, duration);
    }
  }

  let timerInterval = setInterval(updateTimer, 490);
  updateTimer();
});
