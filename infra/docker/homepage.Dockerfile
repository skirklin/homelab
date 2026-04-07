# Static homepage — no build step needed
FROM nginx:alpine
COPY apps/homepage/ /usr/share/nginx/html
EXPOSE 80
