#!/bin/sh

set -eu

awslocal s3api create-bucket --bucket payload-blurhash --region us-east-1 >/dev/null 2>&1 || true
awslocal s3api put-bucket-cors --bucket payload-blurhash --cors-configuration '{
  "CORSRules": [
    {
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["GET", "PUT", "HEAD", "DELETE"],
      "AllowedOrigins": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}'
