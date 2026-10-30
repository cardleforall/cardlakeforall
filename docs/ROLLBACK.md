# Rollback

In Vercel, promote the previous successful production deployment. To revert code, use GitHub to revert the offending commit on `main`; Vercel will deploy the revert automatically. Rotate any secret if it was exposed before restoring service.
