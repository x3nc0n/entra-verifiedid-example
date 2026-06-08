'use strict';

const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.render('index', {
    title: 'Entra Verified ID — Employee Onboarding',
  });
});

module.exports = router;
