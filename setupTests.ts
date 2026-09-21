import '@testing-library/jest-dom/vitest'

// jsdom does not implement native dialog methods; real modal behavior is checked in Chromium.
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '')
}
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open')
  this.dispatchEvent(new Event('close'))
}
