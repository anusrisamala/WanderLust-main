// Example starter JavaScript for disabling form submissions if there are invalid fields
console.log("script working");
(() => {
  'use strict'

  // Fetch all the forms we want to apply custom Bootstrap validation styles to
  const forms = document.querySelectorAll('.needs-validation')

  // Loop over them and prevent submission
  Array.from(forms).forEach(form => {
    form.addEventListener('submit', event => {
      if (!form.checkValidity()) {
        event.preventDefault()
        event.stopPropagation()
      }

      form.classList.add('was-validated')
    }, false)
  })

  // Confirmation dialogs using addEventListener to strictly comply with CSP
  document.addEventListener('submit', event => {
    const form = event.target;
    if (form && typeof form.matches === 'function' && form.matches('[data-confirm]')) {
      const message = form.getAttribute('data-confirm');
      if (message && !window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
  });
})()