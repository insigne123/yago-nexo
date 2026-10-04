# Imagen de laboratorio de Nexo Integrator sobre WSO2 Micro Integrator 4.6.0.
FROM wso2/wso2mi:4.6.0

ARG PG_JDBC_VERSION=42.7.13
ADD --chown=wso2carbon:wso2 https://repo1.maven.org/maven2/org/postgresql/postgresql/${PG_JDBC_VERSION}/postgresql-${PG_JDBC_VERSION}.jar \
    /home/wso2carbon/wso2-config-volume/lib/postgresql-${PG_JDBC_VERSION}.jar
COPY --chown=wso2carbon:wso2 config/ /home/wso2carbon/wso2-config-volume/
ENV JAVA_OPTS="-DenablePrometheusApi=true"

# La imagen base ya corre como wso2carbon (uid 10802); se declara explícito para que el análisis de configuración lo verifique.
USER 10802
